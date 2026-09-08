import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Octo API before importing SessionRouter
vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

import { SessionRouter } from '../session-router.js';
import type { BotMessage } from '../octo/types.js';
import { ChannelType, MessageType } from '../octo/types.js';
import type { Config } from '../config.js';
import { sendMessage } from '../octo/api.js';
import { GroupMdCache, ThreadMdCache } from '../group-md-cache.js';
import type { GroupMdEntry } from '../group-md-cache.js';
import {
  parseDocCommentMention,
  docTaskSessionScope,
  synthesizeDocMentionMessage,
  type DocTaskContext,
} from '../doc-mention.js';
import { parseCardAction, synthesizeCardActionMessage } from '../card-action.js';

const ROBOT_ID = 'bot-001';

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp',
    dataDir: '/tmp/data',
    sdk: { allowedTools: [], permissionMode: 'bypassPermissions', settingSources: ['user'] },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    botBlocklist: ['blocked-bot-1'],
    ...overrides,
  };
}

function makeMsg(overrides?: Partial<BotMessage>): BotMessage {
  return {
    message_id: '1',
    message_seq: 1,
    from_uid: 'user-1',
    channel_id: 'group-1',
    channel_type: ChannelType.Group,
    timestamp: Date.now(),
    payload: { type: MessageType.Text, content: 'hello' },
    ...overrides,
  };
}

describe('SessionRouter', () => {
  let router: SessionRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new SessionRouter(makeConfig(), ROBOT_ID);
  });

  // --- Session key ---

  it('DM session key = from_uid', () => {
    const msg = makeMsg({ channel_type: ChannelType.DM, from_uid: 'u1' });
    expect(router.sessionKey(msg)).toBe('u1');
  });

  it('Group session key = channel_id (shared per-channel, members share one session)', () => {
    const a = makeMsg({ channel_type: ChannelType.Group, channel_id: 'g1', from_uid: 'u1' });
    const b = makeMsg({ channel_type: ChannelType.Group, channel_id: 'g1', from_uid: 'u2' });
    // Both members of g1 map to the same key — the group is a shared workspace.
    expect(router.sessionKey(a)).toBe('g1');
    expect(router.sessionKey(b)).toBe('g1');
    // Different channels stay distinct.
    const c = makeMsg({ channel_type: ChannelType.Group, channel_id: 'g2', from_uid: 'u1' });
    expect(router.sessionKey(c)).toBe('g2');
  });

  it('throws on a group message with no channel_id (never collapses to one shared key)', () => {
    // A channel-less group message is unroutable — falling back to '' would
    // merge unrelated channels into ONE shared session (history/memory leak).
    const m = makeMsg({ channel_type: ChannelType.Group, channel_id: undefined, from_uid: 'u1' });
    expect(() => router.sessionKey(m)).toThrow(/no channel_id/);
  });

  it('DM stays per-user even with the same/other channel', () => {
    const u1 = makeMsg({ channel_type: ChannelType.DM, from_uid: 'u1' });
    const u2 = makeMsg({ channel_type: ChannelType.DM, from_uid: 'u2' });
    expect(router.sessionKey(u1)).not.toBe(router.sessionKey(u2));
  });

  // LOO-12: a DM card click must resume the SAME session the user is talking in.
  // The server contract delivers card_action with a BARE operator_uid and a bare
  // DM channel_id; the normal inbound DM path carries the compound from_uid
  // `s{spaceId}_{peerId}` from which the session key is derived. This locks the
  // cross-module invariant: synthesizeCardActionMessage → router.sessionKey must
  // equal the key of a real inbound DM from the same peer in the same space.
  it('DM card action synthesizes to the same session key as the real inbound DM', () => {
    const SPACE = 'sp9';
    const PEER = 'user-42';

    // A real inbound DM from this peer: octo delivers from_uid compound.
    const inboundDm = makeMsg({
      channel_type: ChannelType.DM,
      from_uid: `s${SPACE}_${PEER}`,
      channel_id: `s${SPACE}_${PEER}@s${SPACE}_${ROBOT_ID}`,
    });

    // The same peer clicks a card in that DM: server sends bare operator_uid +
    // bare channel_id, and the bot synthesizes the re-run message.
    const action = parseCardAction({
      event_id: 7,
      event_type: 'card_action',
      event_data: {
        message_id: 'msg-1',
        channel_id: PEER, // DM channel_id on the wire is the bare peer uid
        channel_type: ChannelType.DM,
        action_id: 'approve',
        operator_uid: PEER, // BARE — c.GetLoginUID() on octo-server
        space_id: SPACE,
      },
    })!;
    const synthesized = synthesizeCardActionMessage(action, ROBOT_ID);

    expect(router.sessionKey(synthesized)).toBe(router.sessionKey(inboundDm));
    // And concretely: the space-aware key, not the bare-uid key it used to be.
    expect(router.sessionKey(synthesized)).toBe(`${SPACE}:s${SPACE}_${PEER}`);
  });

  // --- Self-skip ---

  it('skips messages from self', async () => {
    const msg = makeMsg({ from_uid: ROBOT_ID, channel_type: ChannelType.DM });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  // --- Blocklist ---

  it('skips DM from blocklisted bot', async () => {
    const msg = makeMsg({
      from_uid: 'blocked-bot-1',
      channel_type: ChannelType.DM,
      payload: { type: MessageType.Text, content: 'hi' },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  it('skips group message from blocklisted bot', async () => {
    const msg = makeMsg({
      from_uid: 'blocked-bot-1',
      channel_type: ChannelType.Group,
      payload: {
        type: MessageType.Text,
        content: 'hi',
        mention: { uids: [ROBOT_ID] },
      },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  // --- Mention gate ---

  it('passes DM without mention gate', async () => {
    const msg = makeMsg({ channel_type: ChannelType.DM });
    const result = await router.route(msg);
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('passes group message when mention.uids includes robotId', async () => {
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: 'hi', mention: { uids: [ROBOT_ID] } },
    });
    const result = await router.route(msg);
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('passes group message when mention.ais is truthy', async () => {
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: 'hi', mention: { ais: 1 } },
    });
    const result = await router.route(msg);
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('REJECTS group message when only mention.all is set (humans-only)', async () => {
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: 'hi', mention: { all: 1 } },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  it('rejects group message with no mention at all', async () => {
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: 'hi' },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  // --- System events ---

  it('silently skips system events (payload.event)', async () => {
    const msg = makeMsg({
      channel_type: ChannelType.DM,
      payload: {
        type: MessageType.Text,
        content: '',
        event: { type: 'group_md_updated' },
      },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // --- Non-text message ---

  it('now passes non-text messages through (G1: handled by inbound.resolveContent)', async () => {
    const msg = makeMsg({
      channel_type: ChannelType.DM,
      payload: { type: MessageType.Image, url: 'file/abc.jpg' },
    });
    const result = await router.route(msg);
    expect(result).not.toBeNull();
    // G1: image messages are no longer rejected — they flow through to the
    // pipeline where resolveContent renders them as "[图片] <url>".
    expect(result!.shouldProcess).toBe(true);
    // No “不支持” auto-reply.
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: '暂不支持此类消息，请发送文字' }),
    );
  });

  // --- Rate limiting ---

  it('passes first N requests within limit', async () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 3 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    for (let i = 0; i < 3; i++) {
      const msg = makeMsg({ message_id: String(i), channel_type: ChannelType.DM });
      const result = await router.route(msg);
      expect(result!.shouldProcess).toBe(true);
    }
  });

  it('rejects requests exceeding rate limit', async () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 2 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    // Consume tokens
    await router.route(makeMsg({ message_id: '1', channel_type: ChannelType.DM }));
    await router.route(makeMsg({ message_id: '2', channel_type: ChannelType.DM }));

    // Should be rate limited — first rejection sends notification
    const result = await router.route(makeMsg({ message_id: '3', channel_type: ChannelType.DM }));
    expect(result!.shouldProcess).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '请稍后再试' }),
    );
  });

  it('rate limit debounce: only notifies once per window', async () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 1 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    // Consume the single token
    await router.route(makeMsg({ message_id: '1', channel_type: ChannelType.DM }));
    vi.mocked(sendMessage).mockClear();

    // First rejection — notified
    await router.route(makeMsg({ message_id: '2', channel_type: ChannelType.DM }));
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Subsequent rejections — debounced, no additional notification
    await router.route(makeMsg({ message_id: '3', channel_type: ChannelType.DM }));
    await router.route(makeMsg({ message_id: '4', channel_type: ChannelType.DM }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rate limit applies to non-text messages too', async () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 1 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    // Consume the single token with a text message
    await router.route(makeMsg({ message_id: '1', channel_type: ChannelType.DM }));

    // Non-text message should be rate limited, not replied with "暂不支持"
    vi.mocked(sendMessage).mockClear();
    const result = await router.route(makeMsg({
      message_id: '2',
      channel_type: ChannelType.DM,
      payload: { type: MessageType.Image },
    }));
    expect(result!.shouldProcess).toBe(false);
    // Should get rate limit notification, not the non-text notice
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '请稍后再试' }),
    );
  });

  // --- Serial queue ---

  it('group rate limit is per-member, not one shared bucket for the whole channel', async () => {
    // Regression: with the per-channel sessionKey, keying the session bucket by
    // sessionKey alone collapsed the whole room into one quota. Each member must
    // get their own maxPerMinute in the same channel.
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 2 } });
    router = new SessionRouter(cfg, ROBOT_ID);
    const CH = 'group-shared';
    const mentioned = { type: MessageType.Text, content: 'hi', mention: { uids: [ROBOT_ID] } };

    // Alice uses her full quota (2).
    const a1 = await router.route(makeMsg({ message_id: 'a1', channel_id: CH, from_uid: 'alice', channel_type: ChannelType.Group, payload: mentioned }));
    const a2 = await router.route(makeMsg({ message_id: 'a2', channel_id: CH, from_uid: 'alice', channel_type: ChannelType.Group, payload: mentioned }));
    expect(a1!.shouldProcess).toBe(true);
    expect(a2!.shouldProcess).toBe(true);

    // Bob in the SAME channel still has his own quota — not blocked by Alice.
    const b1 = await router.route(makeMsg({ message_id: 'b1', channel_id: CH, from_uid: 'bob', channel_type: ChannelType.Group, payload: mentioned }));
    const b2 = await router.route(makeMsg({ message_id: 'b2', channel_id: CH, from_uid: 'bob', channel_type: ChannelType.Group, payload: mentioned }));
    expect(b1!.shouldProcess).toBe(true);
    expect(b2!.shouldProcess).toBe(true);

    // Alice's 3rd IS blocked (her own quota exhausted).
    const a3 = await router.route(makeMsg({ message_id: 'a3', channel_id: CH, from_uid: 'alice', channel_type: ChannelType.Group, payload: mentioned }));
    expect(a3!.shouldProcess).toBe(false);
  });

  it('sessionKey throws on a DM with empty from_uid (no shared-session collapse)', () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 5 } });
    router = new SessionRouter(cfg, ROBOT_ID);
    const msg = makeMsg({ channel_type: ChannelType.DM, from_uid: '', channel_id: 'dm-ch' });
    expect(() => router.sessionKey(msg)).toThrow(/no from_uid/);
  });

  // --- Serial queue (continued) ---

  it('processes same session key sequentially', async () => {
    const order: number[] = [];
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 100 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    const promises = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      promises.push(
        router.route(makeMsg({ message_id: String(idx), channel_type: ChannelType.DM })).then(() => {
          order.push(idx);
        }),
      );
    }
    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

// ─── routeAndHandle: Concurrency + Lock Integration ─────────────────────────

describe('routeAndHandle concurrency', () => {
  let router: SessionRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new SessionRouter(makeConfig({ rateLimit: { maxPerMinute: 100 } }), ROBOT_ID);
  });

  it('same session key: route + handler execute serially (FIFO)', async () => {
    const order: number[] = [];

    const promises = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      promises.push(
        router.routeAndHandle(
          makeMsg({
            message_id: String(idx),
            channel_type: ChannelType.DM,
            from_uid: 'same-user',
          }),
          async () => {
            // Simulate async work to expose ordering bugs
            await new Promise((r) => setTimeout(r, 1));
            order.push(idx);
          },
        ),
      );
    }
    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('different session keys run in parallel', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        router.routeAndHandle(
          makeMsg({
            message_id: String(i),
            channel_type: ChannelType.DM,
            from_uid: `user-${i}`, // different session keys
          }),
          async () => {
            current++;
            maxConcurrent = Math.max(maxConcurrent, current);
            await new Promise((r) => setTimeout(r, 10));
            current--;
          },
        ),
      );
    }
    await Promise.all(promises);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('handler runs inside the lock (max 1 concurrent per session)', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        router.routeAndHandle(
          makeMsg({
            message_id: String(i),
            channel_type: ChannelType.DM,
            from_uid: 'same-user',
          }),
          async () => {
            current++;
            maxConcurrent = Math.max(maxConcurrent, current);
            await new Promise((r) => setTimeout(r, 5));
            current--;
          },
        ),
      );
    }
    await Promise.all(promises);
    expect(maxConcurrent).toBe(1);
  });

  it('routeAndHandle does not call handler for non-processable messages', async () => {
    const handlerCalls: string[] = [];

    // Group message without mention — should not be processed
    await router.routeAndHandle(
      makeMsg({
        channel_type: ChannelType.Group,
        payload: { type: MessageType.Text, content: 'no mention' },
      }),
      async (result) => {
        handlerCalls.push(result.sessionKey);
      },
    );

    expect(handlerCalls).toHaveLength(0);
  });

  it('routeAndHandle calls handler for processable messages', async () => {
    const handlerCalls: string[] = [];

    // DM text message — should be processed
    await router.routeAndHandle(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'user-1',
        payload: { type: MessageType.Text, content: 'hello' },
      }),
      async (result) => {
        handlerCalls.push(result.sessionKey);
      },
    );

    expect(handlerCalls).toEqual(['user-1']);
  });

  it('burst of same-session messages: FIFO order + max-1 concurrent', async () => {
    const order: number[] = [];
    let maxConcurrent = 0;
    let current = 0;

    const burst = 10;
    const promises = [];
    for (let i = 0; i < burst; i++) {
      const idx = i;
      promises.push(
        router.routeAndHandle(
          makeMsg({
            message_id: String(idx),
            channel_type: ChannelType.DM,
            from_uid: 'burst-user',
          }),
          async () => {
            current++;
            maxConcurrent = Math.max(maxConcurrent, current);
            await new Promise((r) => setTimeout(r, 1));
            order.push(idx);
            current--;
          },
        ),
      );
    }
    await Promise.all(promises);

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

// ─── #141: Dispatch timeout ────────────────────────────────────────────────

describe('dispatch timeout (#141)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a hung turn HOLDS the session lock — a same-session message queues until it settles (never concurrent)', async () => {
    // Reworked for the #141 refit (PR #21 review): we never cancel the in-flight
    // turn, so we must never release the lock while it runs — otherwise a
    // follow-up message would start a CONCURRENT query() on the same SDK session.
    // The old assertion (message 2 runs after the timeout) codified that unsafe
    // behavior; the correct behavior is that message 2 stays QUEUED until the turn
    // truly settles.
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 30, dispatchTimeoutMs: 10_000 }),
      ROBOT_ID,
    );
    const completed: number[] = [];
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });

    // Message 1: a stalled turn — silent (no activity), never settles until released.
    const p1 = router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'same-user' }),
      () => hang,
    );
    // Message 2: same session — must NOT start while message 1 is still running.
    const p2 = router.routeAndHandle(
      makeMsg({ message_id: '2', channel_type: ChannelType.DM, from_uid: 'same-user' }),
      async () => { completed.push(2); },
    );

    // Past idle (30ms), well under total (10s): message 1 got its apology, but the
    // lock is still held, so message 2 has NOT run.
    await new Promise((r) => setTimeout(r, 120));
    expect(completed).toEqual([]);
    expect(sendMessage).toHaveBeenCalledTimes(1); // idle apology for message 1

    // The stalled turn settles → lock frees → message 2 finally runs (serially).
    release();
    await Promise.all([p1, p2]);
    expect(completed).toEqual([2]);
    expect(sendMessage).toHaveBeenCalledTimes(1); // no second apology on settle
  });

  it('surfaces a single bounded apology on an idle stall (lock still held)', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 30, dispatchTimeoutMs: 10_000 }),
      ROBOT_ID,
    );
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });

    const p = router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      () => hang,
    );

    await new Promise((r) => setTimeout(r, 120));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMessage).mock.calls[0][0]).toMatchObject({
      content: expect.stringContaining('仍在处理中'),
    });

    release();
    await p;
    expect(sendMessage).toHaveBeenCalledTimes(1); // exactly one, even after settle
  });

  it('does not fire for a normal fast handler', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, dispatchTimeoutMs: 1000 }),
      ROBOT_ID,
    );
    let ran = false;

    await router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      async () => { ran = true; },
    );

    expect(ran).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('disabled (0) runs the handler unguarded', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, dispatchTimeoutMs: 0 }),
      ROBOT_ID,
    );
    let ran = false;

    await router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      async () => { ran = true; },
    );

    expect(ran).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('invokes a handler-registered onDispatchTimeout hook on a stall (A6: card → stopped)', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 30, dispatchTimeoutMs: 10_000 }),
      ROBOT_ID,
    );
    let stopped = false;
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });

    const p = router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      (result) => {
        // The handler registers a per-turn stop hook (as index.ts does for the
        // progress card) and then stalls — the timeout must invoke the hook.
        result.onDispatchTimeout = () => { stopped = true; };
        return hang;
      },
    );

    await new Promise((r) => setTimeout(r, 120));
    expect(stopped).toBe(true);
    // The apology goes out exactly once alongside the hook.
    expect(sendMessage).toHaveBeenCalledTimes(1);

    release();
    await p;
  });

  it('does not invoke onDispatchTimeout for a normal fast handler', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, dispatchTimeoutMs: 1000 }),
      ROBOT_ID,
    );
    let stopped = false;

    await router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      async (result) => { result.onDispatchTimeout = () => { stopped = true; }; },
    );

    expect(stopped).toBe(false);
  });

  it('a rejecting handler does not wedge the session (next message still runs)', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, dispatchTimeoutMs: 1000 }),
      ROBOT_ID,
    );
    const completed: number[] = [];

    // Message 1: handler rejects fast (a real handler error, not a timeout).
    await router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'same-user' }),
      async () => { throw new Error('boom'); },
    );
    // Message 2: same session — must still run (lock released, no timeout apology).
    await router.routeAndHandle(
      makeMsg({ message_id: '2', channel_type: ChannelType.DM, from_uid: 'same-user' }),
      async () => { completed.push(2); },
    );

    expect(completed).toEqual([2]);
    // A non-timeout error must NOT trigger the timeout apology.
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// ─── #141 refit: activity (idle) watchdog ──────────────────────────────────

describe('idle watchdog (#141 activity-based dispatch bound)', () => {
  const IDLE_DOC_BOT = 'bot_idle_1';
  const idleDocMention = parseDocCommentMention({
    event_id: 9,
    event_type: 'doc_comment_mention',
    event_data: {
      idempotency_key: 'idem-idle', doc_id: 'doc_9', comment_id: 'c9', thread_id: '99',
      from_uid: 'u_author', bot_uid: IDLE_DOC_BOT, text: 'fix it',
    },
  })!;
  const idleDocCtx: DocTaskContext = {
    docId: idleDocMention.docId, threadId: idleDocMention.threadId, commentId: idleDocMention.commentId,
    sessionScope: docTaskSessionScope(idleDocMention), postComment: async () => {}, reportTurn: () => {},
  };
  const idleDocFire = (): BotMessage => synthesizeDocMentionMessage(idleDocMention, IDLE_DOC_BOT, idleDocCtx);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(a) never judges a healthy-but-slow turn hung while it keeps emitting events', async () => {
    // idle=40ms, total=10s. The handler beats the activity beacon every 15ms for
    // ~120ms — total wall-clock (120ms) far exceeds idle (40ms), but no single
    // gap does, so a fixed wall-clock timer would have killed it and the activity
    // watchdog must not.
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 40, dispatchTimeoutMs: 10_000 }),
      ROBOT_ID,
    );
    let finished = false;

    await router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      async (result) => {
        for (let i = 0; i < 8; i++) {
          result.notifyActivity?.(); // "still running" heartbeat
          await new Promise((r) => setTimeout(r, 15));
        }
        result.notifyStreamSettled?.();
        finished = true;
      },
    );

    expect(finished).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled(); // never judged hung
  });

  it('(b) an idle stall surfaces feedback + the stop hook but KEEPS the lock (no concurrent turn)', async () => {
    // idle=30ms, total=10s. Message 1 goes silent immediately (no heartbeats) →
    // idle notice fires, but the lock is NOT released (no timeout level releases
    // it — the turn is never cancelled, so it runs to completion in-lock), so a
    // same-session message 2 stays QUEUED — never starts a concurrent turn.
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 30, dispatchTimeoutMs: 10_000 }),
      ROBOT_ID,
    );
    const log: string[] = [];
    let releaseHang!: () => void;
    const hang = new Promise<void>((r) => { releaseHang = r; });

    const p1 = router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'same' }),
      (result) => {
        result.onDispatchTimeout = () => log.push('stop-hook');
        return hang; // silent + never settles until we release it
      },
    );
    const p2 = router.routeAndHandle(
      makeMsg({ message_id: '2', channel_type: ChannelType.DM, from_uid: 'same' }),
      async () => { log.push('msg2-ran'); },
    );

    // Past idle (30ms), well under total (10s).
    await new Promise((r) => setTimeout(r, 120));

    expect(sendMessage).toHaveBeenCalledTimes(1); // one idle apology
    expect(vi.mocked(sendMessage).mock.calls[0][0]).toMatchObject({
      content: expect.stringContaining('仍在处理中'),
    });
    expect(log).toContain('stop-hook'); // onDispatchTimeout fired at the idle notice
    expect(log).not.toContain('msg2-ran'); // lock held → message 2 still queued

    // Release the wedged turn → lock frees → message 2 finally runs. No second apology.
    releaseHang();
    await Promise.all([p1, p2]);
    expect(log).toContain('msg2-ran');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('(c) does not mistake the post-stream settle window for a stall', async () => {
    // The stream drains (one event, then notifyStreamSettled), then the turn stays
    // quiet for 120ms of settle/post-work — longer than idle (30ms). Because the
    // stream has settled, the idle watchdog is suspended and no apology is sent.
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 30, dispatchTimeoutMs: 10_000 }),
      ROBOT_ID,
    );
    let finished = false;

    await router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      async (result) => {
        result.notifyActivity?.();      // one stream event
        result.notifyStreamSettled?.(); // stream fully drained → suspend idle watchdog
        await new Promise((r) => setTimeout(r, 120)); // quiet settle window > idle
        finished = true;
      },
    );

    expect(finished).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled(); // settle window is not a stall
  });

  it('(d) clamps an oversized backstop so it does not overflow setTimeout to ~1ms (#121)', async () => {
    // dispatchTimeoutMs beyond 2**31-1 must be clamped: an unclamped value is
    // coerced by Node to a 1ms delay, firing the backstop on the next tick and
    // apologizing to every message. Idle disabled to isolate the total backstop.
    const router = new SessionRouter(
      makeConfig({
        rateLimit: { maxPerMinute: 100 },
        idleTimeoutMs: 0,
        dispatchTimeoutMs: 2 ** 31 + 5_000, // > 2**31-1
      }),
      ROBOT_ID,
    );
    let finished = false;

    await router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      async () => {
        await new Promise((r) => setTimeout(r, 60));
        finished = true;
      },
    );

    expect(finished).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled(); // unclamped, the backstop would fire at ~1ms
  });

  it('(e) idle watchdog is inert for a doc task (force-await path is unchanged)', async () => {
    // A doc fire must ignore both timeout levels and bind to the real turn settle
    // (severe fix 2b). The idle watchdog must not release or apologize for it.
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 20, dispatchTimeoutMs: 40 }),
      IDLE_DOC_BOT,
    );
    let handlerSettled = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const p = router.routeAndHandle(idleDocFire(), async () => {
      await gate; // outlives both idle (20ms) and total (40ms)
      handlerSettled = true;
    });

    await new Promise((r) => setTimeout(r, 90)); // past both levels
    let resolvedEarly = false;
    void p.then(() => { resolvedEarly = true; });
    await new Promise((r) => setTimeout(r, 0));

    expect(resolvedEarly).toBe(false); // still bound to the real turn
    expect(handlerSettled).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled(); // no IM apology for a doc task

    release();
    await p;
    expect(handlerSettled).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('(f) total-ceiling stall (idle disabled) keeps the lock — 2nd same-session query does not start until the 1st settles', async () => {
    // PR #21 review regression: with idle disabled, the total ceiling is the only
    // trip, and it must ALSO keep the lock (never release). A second same-session
    // message must not start its turn (its query) until the first turn settles.
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 0, dispatchTimeoutMs: 30 }),
      ROBOT_ID,
    );
    const started: number[] = [];
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });

    const p1 = router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'same' }),
      () => { started.push(1); return hang; },
    );
    const p2 = router.routeAndHandle(
      makeMsg({ message_id: '2', channel_type: ChannelType.DM, from_uid: 'same' }),
      async () => { started.push(2); },
    );

    await new Promise((r) => setTimeout(r, 120)); // well past total (30ms)
    expect(started).toEqual([1]);                 // turn 2 has NOT started
    expect(sendMessage).toHaveBeenCalledTimes(1); // total-ceiling apology

    release();
    await Promise.all([p1, p2]);
    expect(started).toEqual([1, 2]);              // turn 2 started only after turn 1 settled
    expect(sendMessage).toHaveBeenCalledTimes(1); // no second apology
  });

  it('(g) total ceiling STILL fires after notifyStreamSettled — a hung post-stream settle is bounded, 2nd same-session turn queues until release', async () => {
    // PR #21 review #2: notifyStreamSettled must suspend ONLY the idle watchdog.
    // The total ceiling has to survive the settle so a hung post-stream phase
    // (delivery / history write / card finalize) is still bounded. idle disabled
    // to isolate total; short total (30ms).
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 0, dispatchTimeoutMs: 30 }),
      ROBOT_ID,
    );
    const started: number[] = [];
    let stopped = false;
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });

    const p1 = router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'same' }),
      (result) => {
        result.onDispatchTimeout = () => { stopped = true; };
        started.push(1);
        // Stream drains immediately, but the post-stream settle work hangs past
        // the total ceiling — total must still fire.
        result.notifyStreamSettled?.();
        return hang;
      },
    );
    const p2 = router.routeAndHandle(
      makeMsg({ message_id: '2', channel_type: ChannelType.DM, from_uid: 'same' }),
      async () => { started.push(2); },
    );

    await new Promise((r) => setTimeout(r, 120)); // well past total (30ms), AFTER settle
    expect(stopped).toBe(true);                    // total fired despite stream settled
    expect(sendMessage).toHaveBeenCalledTimes(1);  // one total-ceiling apology
    expect(started).toEqual([1]);                  // 2nd turn still queued (lock held)

    release();
    await Promise.all([p1, p2]);
    expect(started).toEqual([1, 2]);               // 2nd runs only after 1st settles
    expect(sendMessage).toHaveBeenCalledTimes(1);  // no second apology
  });
});

// ─── LOO-18: copy grading + liveness heartbeat + settle log ─────────────────

describe('LOO-18 dispatch follow-up (copy grading / heartbeat / settle log)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) idle vs total copy are DISTINCT and semantically correct: the idle notice
  // reassures without offering a retry (the turn is still alive and will keep
  // producing a result — a retry only queues behind it); the total notice, the
  // 30-min hard ceiling, is the one case where retrying later is reasonable.
  it('(a) idle and total notices carry distinct, semantically-correct copy', async () => {
    // idle path: small idle, large total → idle trips first.
    const idleRouter = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 20, dispatchTimeoutMs: 10_000 }),
      ROBOT_ID,
    );
    let releaseIdle!: () => void;
    const idleHang = new Promise<void>((r) => { releaseIdle = r; });
    const pIdle = idleRouter.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u_idle' }),
      () => idleHang,
    );
    await new Promise((r) => setTimeout(r, 80));
    const idleContent = String(vi.mocked(sendMessage).mock.calls[0][0].content);
    releaseIdle();
    await pIdle;

    vi.clearAllMocks();

    // total path: idle disabled, small total → only the total ceiling trips.
    const totalRouter = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 0, dispatchTimeoutMs: 20 }),
      ROBOT_ID,
    );
    let releaseTotal!: () => void;
    const totalHang = new Promise<void>((r) => { releaseTotal = r; });
    const pTotal = totalRouter.routeAndHandle(
      makeMsg({ message_id: '2', channel_type: ChannelType.DM, from_uid: 'u_total' }),
      () => totalHang,
    );
    await new Promise((r) => setTimeout(r, 80));
    const totalContent = String(vi.mocked(sendMessage).mock.calls[0][0].content);
    releaseTotal();
    await pTotal;

    // Distinct copy.
    expect(idleContent).not.toBe(totalContent);
    // idle: reassures, never tells the user to retry (turn is still running).
    expect(idleContent).toContain('仍在处理中');
    expect(idleContent).not.toMatch(/重试|重新/);
    // total: the hard-ceiling case — retrying later is a reasonable suggestion.
    expect(totalContent).toMatch(/重试|重新/);
  });

  // (b) a healthy-but-slow turn whose ONLY traffic is the liveness heartbeat
  // (periodic notifyActivity, no other events) is never misjudged idle, even
  // though total wall-clock far exceeds the idle window — the beacon refresh
  // keeps lastEventAt fresh. Mirrors the agent-bridge heartbeat that fires while a
  // tool is in-flight.
  it('(b) a periodic liveness heartbeat refreshes lastEventAt and prevents a false idle notice', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 40, dispatchTimeoutMs: 10_000 }),
      ROBOT_ID,
    );
    let finished = false;
    await router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      async (result) => {
        // ~150ms total, each quiet gap (25ms) < idle (40ms): a fixed wall-clock
        // timer would have fired; the activity beacon must not.
        for (let i = 0; i < 6; i++) {
          result.notifyActivity?.(); // heartbeat only — no stream event
          await new Promise((r) => setTimeout(r, 25));
        }
        result.notifyStreamSettled?.();
        finished = true;
      },
    );
    expect(finished).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // (c) the CRITICAL guarantee: a continuous heartbeat must NOT degrade into
  // "never times out". A turn that keeps beating forever (e.g. a tool subprocess
  // that hangs — the heartbeat criterion stays TRUE the whole time, so idle is
  // never tripped) is STILL bounded by the total ceiling, which is independent of
  // activity. This proves the heartbeat only ever touches the idle beacon.
  it('(c) a forever-beating (wedged-tool) turn still trips the total backstop', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 40, dispatchTimeoutMs: 100 }),
      ROBOT_ID,
    );
    let stopHook = false;
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });
    let beat: ReturnType<typeof setInterval> | undefined;

    const p = router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      (result) => {
        result.onDispatchTimeout = () => { stopHook = true; };
        // Beat every 10ms — well under idle (40ms) — so idle NEVER trips.
        beat = setInterval(() => result.notifyActivity?.(), 10);
        return hang;
      },
    );

    await new Promise((r) => setTimeout(r, 200)); // past total (100ms)
    expect(stopHook).toBe(true);                  // total fired despite continuous beats
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(sendMessage).mock.calls[0][0].content)).toMatch(/重试|重新/); // total copy

    if (beat) clearInterval(beat);
    release();
    await p;
    expect(sendMessage).toHaveBeenCalledTimes(1); // still exactly one notice
  });

  // (d) the settle log fires on BOTH paths — a turn that surfaced a notice and a
  // turn that finished cleanly — so ops can tell "slow-but-recovered" from
  // "healthy" after the fact. It records which level (if any) surfaced.
  it('(d) logs a settle line on both the surfaced and the clean path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const router = new SessionRouter(
        makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 20, dispatchTimeoutMs: 10_000 }),
        ROBOT_ID,
      );

      // Clean path: fast handler, never surfaces.
      await router.routeAndHandle(
        makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u_clean' }),
        async () => { /* returns immediately */ },
      );

      // Surfaced path: idle stall → one idle notice, then settles.
      let release!: () => void;
      const hang = new Promise<void>((r) => { release = r; });
      const p = router.routeAndHandle(
        makeMsg({ message_id: '2', channel_type: ChannelType.DM, from_uid: 'u_slow' }),
        () => hang,
      );
      await new Promise((r) => setTimeout(r, 60));
      release();
      await p;

      const settleLogs = logSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('turn settled'));
      // One settle line per turn.
      expect(settleLogs.length).toBe(2);
      // Clean turn: surfaced=none. Slow turn: surfaced=idle.
      expect(settleLogs.some((l) => l.includes('surfaced=none'))).toBe(true);
      expect(settleLogs.some((l) => l.includes('surfaced=idle'))).toBe(true);
      // Elapsed is recorded on every line.
      expect(settleLogs.every((l) => /elapsedMs=\d+/.test(l))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ─── Doc-task egress purity + claim lifecycle (severe fixes 2a / 2b) ─────────

describe('doc-task dispatch (2a egress purity + 2b claim lifecycle)', () => {
  const DOC_BOT = 'bot_1';
  const docMention = parseDocCommentMention({
    event_id: 5,
    event_type: 'doc_comment_mention',
    event_data: {
      idempotency_key: 'idem-1', doc_id: 'doc_1', comment_id: 'c1', thread_id: '70',
      from_uid: 'u_author', bot_uid: DOC_BOT, text: 'fix it',
    },
  })!;
  const docCtx: DocTaskContext = {
    docId: docMention.docId, threadId: docMention.threadId, commentId: docMention.commentId,
    sessionScope: docTaskSessionScope(docMention), postComment: async () => {}, reportTurn: () => {},
  };
  const docFire = (): BotMessage => synthesizeDocMentionMessage(docMention, DOC_BOT, docCtx);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('2a: a rate-limited doc fire never touches the IM send path', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 1 } }),
      DOC_BOT,
    );
    // First fire consumes the single token; the second trips the per-user bucket.
    await router.route(docFire());
    const blocked = await router.route(docFire());

    expect(blocked?.rejectionReason).toBe('rate_limited');
    // 2a: replySafe must NOT synthesize a '请稍后再试' onto IM for a doc task.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('2a: a dispatch timeout produces no IM apology for a doc fire', async () => {
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, dispatchTimeoutMs: 20 }),
      DOC_BOT,
    );
    let handlerSettled = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const p = router.routeAndHandle(docFire(), async () => {
      await gate; // a real turn that outlives the dispatch timeout
      handlerSettled = true;
    });

    // Wait well past the 20ms dispatch timeout.
    await new Promise((r) => setTimeout(r, 60));

    // 2b: a doc task is bound to the REAL turn settle — dispatch must NOT resolve
    // early on timeout while the turn is still running in the background.
    let resolvedEarly = false;
    void p.then(() => { resolvedEarly = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolvedEarly).toBe(false);
    expect(handlerSettled).toBe(false);
    // 2a: no IM apology despite the elapsed timeout.
    expect(sendMessage).not.toHaveBeenCalled();

    // Let the turn settle → only now does dispatch resolve (bound to true completion).
    release();
    await p;
    expect(handlerSettled).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('2b: a normal (non-doc) stalled turn still surfaces the apology (doc guard is not global)', async () => {
    // Control: the doc-task force-await binding is doc-specific; an ordinary turn
    // still gets the #141 dispatch NOTICE on a stall (proving the doc-only guard
    // didn't disable the watchdog globally). Post-#21-review the notice keeps the
    // lock rather than releasing it — but it still fires for a normal turn.
    const router = new SessionRouter(
      makeConfig({ rateLimit: { maxPerMinute: 100 }, idleTimeoutMs: 20, dispatchTimeoutMs: 10_000 }),
      DOC_BOT,
    );
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });

    const p = router.routeAndHandle(
      makeMsg({ message_id: '1', channel_type: ChannelType.DM, from_uid: 'u1' }),
      () => hang,
    );
    await new Promise((r) => setTimeout(r, 90));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMessage).mock.calls[0][0]).toMatchObject({
      content: expect.stringContaining('仍在处理中'),
    });

    release();
    await p;
  });
});

// ─── Q10: Message length limit ─────────────────────────────────────────────

describe('Message length limit (Q10)', () => {
  it('rejects messages exceeding 32KB', async () => {
    const config = makeConfig();
    const router = new SessionRouter(config, ROBOT_ID);
    const longContent = 'A'.repeat(33_000); // > 32KB

    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'long-msg-user',
        payload: { type: MessageType.Text, content: longContent },
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '消息过长，请缩短后重试' }),
    );
  });

  it('accepts messages at exactly 32KB', async () => {
    const config = makeConfig();
    const router = new SessionRouter(config, ROBOT_ID);
    const exactContent = 'A'.repeat(32_768); // exactly 32KB ASCII

    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'exact-limit-user',
        payload: { type: MessageType.Text, content: exactContent },
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('measures length in bytes not chars (CJK)', async () => {
    const config = makeConfig();
    const router = new SessionRouter(config, ROBOT_ID);
    // 11000 CJK chars × 3 bytes = 33000 bytes > 32KB
    const cjkContent = '中'.repeat(11_000);

    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'cjk-user',
        payload: { type: MessageType.Text, content: cjkContent },
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(false);
  });
});

// ─── G14: bot-to-bot DM loop prevention ────────────────────────────────────────────

describe('G14: bot-to-bot DM loop prevention', () => {
  it('drops DM from a uid ending in _bot', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'random_bot',
        payload: { type: MessageType.Text, content: 'hi' },
      }),
    );
    expect(result).toBeNull();
  });

  it('drops DM from the bot itself (knownBotUids includes self)', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: ROBOT_ID,
        payload: { type: MessageType.Text, content: 'hi' },
      }),
    );
    expect(result).toBeNull();
  });

  it('drops DM from a registered known bot uid', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    router.registerKnownBot('peer-bot-uid');
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'peer-bot-uid',
        payload: { type: MessageType.Text, content: 'hi' },
      }),
    );
    expect(result).toBeNull();
  });

  it('allows DM from a bot in allowedBotUids whitelist', async () => {
    const router = new SessionRouter(
      makeConfig({ allowedBotUids: ['trusted_bot'] }),
      ROBOT_ID,
    );
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'trusted_bot',
        payload: { type: MessageType.Text, content: 'hi' },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('allows DM from a regular human user (no _bot suffix)', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: 'alice123',
        payload: { type: MessageType.Text, content: 'hi' },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('does NOT drop group messages from _bot uid (mention gate handles those)', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    // Without @mention, group msg from bot would be dropped by mention gate, not G14.
    // With @mention, it should pass.
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.Group,
        from_uid: 'someone_bot',
        payload: {
          type: MessageType.Text,
          content: 'hi',
          mention: { uids: [ROBOT_ID] },
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });
});

// ─── #157: unregisterKnownBot (hot-reload sibling removal) ───────────────────

describe('#157: unregisterKnownBot', () => {
  it('drops a registered sibling, then processes it again after unregister', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    router.registerKnownBot('peer-bot-uid');
    const dm = () =>
      router.route(
        makeMsg({
          channel_type: ChannelType.DM,
          from_uid: 'peer-bot-uid',
          payload: { type: MessageType.Text, content: 'hi' },
        }),
      );
    // While registered: dropped as a known bot.
    expect(await dm()).toBeNull();
    // After unregister: no longer a known bot → treated as a normal DM peer.
    router.unregisterKnownBot('peer-bot-uid');
    const after = await dm();
    expect(after).not.toBeNull();
    expect(after!.shouldProcess).toBe(true);
  });

  it('refuses to unregister the router its own robotId (self is always a bot)', async () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    router.unregisterKnownBot(ROBOT_ID);
    // Self must still be treated as a bot — its own echoes stay dropped.
    const result = await router.route(
      makeMsg({
        channel_type: ChannelType.DM,
        from_uid: ROBOT_ID,
        payload: { type: MessageType.Text, content: 'hi' },
      }),
    );
    expect(result).toBeNull();
    expect(router.knownBotUidsSnapshot().has(ROBOT_ID)).toBe(true);
  });

  it('is idempotent and safe for unknown / empty uids', () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    expect(() => router.unregisterKnownBot('never-registered')).not.toThrow();
    expect(() => router.unregisterKnownBot('')).not.toThrow();
    router.registerKnownBot('peer');
    router.unregisterKnownBot('peer');
    router.unregisterKnownBot('peer'); // second time is a no-op
    expect(router.knownBotUidsSnapshot().has('peer')).toBe(false);
  });

  it('snapshot reflects register/unregister and is a copy (not live)', () => {
    const router = new SessionRouter(makeConfig(), ROBOT_ID);
    router.registerKnownBot('peer');
    const snap = router.knownBotUidsSnapshot();
    expect(snap.has('peer')).toBe(true);
    expect(snap.has(ROBOT_ID)).toBe(true);
    // Mutating after snapshot must not change the already-returned set.
    router.unregisterKnownBot('peer');
    expect(snap.has('peer')).toBe(true); // snapshot is a copy
    expect(router.knownBotUidsSnapshot().has('peer')).toBe(false);
  });
});

// ─── G18: owner_uid storage ────────────────────────────────────────────────────────────

describe('G18: owner_uid storage', () => {
  it('SessionRouter accepts and stores ownerUid (default empty)', () => {
    const r1 = new SessionRouter(makeConfig(), ROBOT_ID);
    expect(r1).toBeDefined(); // construct without ownerUid arg
    const r2 = new SessionRouter(makeConfig(), ROBOT_ID, 'owner-uid-xyz');
    expect(r2).toBeDefined(); // construct with ownerUid arg
  });
});

// ─── G20: per-user cross-channel rate limit + debounce correctness ────────────────

describe('G20: per-user cross-channel rate limit', () => {
  it('per-user limit blocks across different groups', async () => {
    // 5 req/min limit. Send 5 messages from same user across different groups
    // — 6th should be rate-limited even though each group has its own session.
    const router = new SessionRouter(makeConfig({ rateLimit: { maxPerMinute: 5 } }), ROBOT_ID);
    const uid = 'spammer-1';
    let blocked = 0;
    for (let i = 0; i < 7; i++) {
      const result = await router.route(
        makeMsg({
          channel_id: `group-${i}`, // different group each time
          channel_type: ChannelType.Group,
          from_uid: uid,
          payload: {
            type: MessageType.Text,
            content: 'msg',
            mention: { uids: [ROBOT_ID] },
          },
        }),
      );
      if (result && !result.shouldProcess) blocked++;
    }
    expect(blocked).toBeGreaterThanOrEqual(2); // at least 2 of the 7 should be blocked
  });

  it('debounce: blocked user receives at most one notice per refill window', async () => {
    const router = new SessionRouter(makeConfig({ rateLimit: { maxPerMinute: 2 } }), ROBOT_ID);
    const uid = 'user-debounce';
    vi.clearAllMocks();
    // Burn through quota across multiple groups
    for (let i = 0; i < 10; i++) {
      await router.route(
        makeMsg({
          channel_id: `g-${i}`,
          channel_type: ChannelType.Group,
          from_uid: uid,
          payload: {
            type: MessageType.Text,
            content: 'x',
            mention: { uids: [ROBOT_ID] },
          },
        }),
      );
    }
    // The reply for '请稍后再试' should be sent at most a few times —
    // crucially NOT once per blocked message. Without the fix, every blocked
    // message would trigger another reply (DoS reflection).
    const replyCalls = (sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { content?: string }).content === '请稍后再试',
    );
    expect(replyCalls.length).toBeLessThanOrEqual(2);
  });
});

// ─── v0.3 multi-bot: mention-free group bot-loop guard ─────────────────

describe('multi-bot loop guard in mention-free groups', () => {
  const GROUP = 'mf-group';

  function mfConfig(): Config {
    return makeConfig({ mentionFreeGroups: [GROUP] });
  }
  function mfMsg(fromUid: string): BotMessage {
    return makeMsg({
      from_uid: fromUid,
      channel_id: GROUP,
      channel_type: ChannelType.Group,
      payload: { type: MessageType.Text, content: 'auto reply' },
    });
  }

  it('processes a human message in a mention-free group (baseline)', async () => {
    const r = new SessionRouter(mfConfig(), ROBOT_ID);
    const result = await r.route(mfMsg('human-1'));
    expect(result?.shouldProcess).toBe(true);
  });

  it('drops a _bot-suffixed sender in a mention-free group (no mention)', async () => {
    const r = new SessionRouter(mfConfig(), ROBOT_ID);
    const result = await r.route(mfMsg('helper_bot'));
    expect(result).toBeNull();
  });

  it('drops a registered sibling bot in a mention-free group', async () => {
    const r = new SessionRouter(mfConfig(), ROBOT_ID);
    r.registerKnownBot('bot-002'); // sibling bot id (no _bot suffix)
    const result = await r.route(mfMsg('bot-002'));
    expect(result).toBeNull();
  });

  it('still answers a sibling bot that explicitly @-mentions us', async () => {
    const r = new SessionRouter(mfConfig(), ROBOT_ID);
    r.registerKnownBot('bot-002');
    const msg = mfMsg('bot-002');
    msg.payload.mention = { uids: [ROBOT_ID] };
    const result = await r.route(msg);
    expect(result?.shouldProcess).toBe(true);
  });

  it('honors allowedBotUids whitelist in mention-free groups', async () => {
    const r = new SessionRouter(
      makeConfig({ mentionFreeGroups: [GROUP], allowedBotUids: ['trusted_bot'] }),
      ROBOT_ID,
    );
    const result = await r.route(mfMsg('trusted_bot'));
    expect(result?.shouldProcess).toBe(true);
  });
});

// ─── #68: unsupported/system channel types are dropped ──────────────────

describe('unsupported channel types (system messages)', () => {
  let router: SessionRouter;
  beforeEach(() => {
    vi.clearAllMocks();
    router = new SessionRouter(makeConfig(), ROBOT_ID);
  });

  it('drops a system channel_type (8 "systemcmdonline") with no reply', async () => {
    // Reproduces the live-deployment bug: a system message on channel_type 8
    // must not be processed as a conversation.
    const msg = makeMsg({
      channel_id: 'systemcmdonline',
      channel_type: 8 as unknown as ChannelType,
      from_uid: 'system',
      payload: { type: MessageType.Text, content: '' },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('drops an unknown channel_type (e.g. 99)', async () => {
    const msg = makeMsg({ channel_type: 99 as unknown as ChannelType });
    expect(await router.route(msg)).toBeNull();
  });

  it('still processes a normal DM', async () => {
    const msg = makeMsg({
      channel_id: 'dm-1', channel_type: ChannelType.DM, from_uid: 'human',
      payload: { type: MessageType.Text, content: 'hi' },
    });
    const result = await router.route(msg);
    expect(result?.shouldProcess).toBe(true);
  });
});

describe('SessionRouter — thread (CommunityTopic) session isolation [#88]', () => {
  let router: SessionRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new SessionRouter(makeConfig(), ROBOT_ID);
  });

  it('a thread composite channel_id keys a session distinct from its parent group', () => {
    const GROUP = '99dc18164a29435f9791dc37023f98e1';
    const COMPOSITE = `${GROUP}____2071488441815666688`;

    const parent = makeMsg({ channel_type: ChannelType.Group, channel_id: GROUP, from_uid: 'u1' });
    const thread = makeMsg({ channel_type: ChannelType.CommunityTopic, channel_id: COMPOSITE, from_uid: 'u1' });

    // The composite id IS the session key, so the thread never shares the
    // parent group's session/history/cwd/memory partition.
    expect(router.sessionKey(thread)).toBe(COMPOSITE);
    expect(router.sessionKey(thread)).not.toBe(router.sessionKey(parent));
  });

  it('two threads under the same parent get independent sessions', () => {
    const GROUP = 'g1';
    const a = makeMsg({ channel_type: ChannelType.CommunityTopic, channel_id: `${GROUP}____aaa`, from_uid: 'u1' });
    const b = makeMsg({ channel_type: ChannelType.CommunityTopic, channel_id: `${GROUP}____bbb`, from_uid: 'u1' });
    expect(router.sessionKey(a)).not.toBe(router.sessionKey(b));
  });
});

// --- P2-B: server GROUP.md change events drive a cache refresh ---
//
// GROUP.md change events are delivered on a system/DM channel (a group event on
// the group's own channel dies at the mention gate before reaching the event
// branch — XIN-173), so the group identity travels in `event.group_no`, not the
// arriving channel_id. The event.type literal is PROVISIONAL (group-md-events.ts)
// — these tests use the default literal and an explicit override to lock in BOTH
// the routing (md event → invalidate; everything else → dropped, never
// invalidated) and the config-override seam, so calibrating the literal later
// needs no test rewrite.
describe('SessionRouter — GROUP.md event-driven cache refresh (P2-B)', () => {
  const GROUP = 'group-abc';

  function makeEntry(): GroupMdEntry {
    return { content: '# cached', version: 1, updated_at: null };
  }

  function makeRouter(cache?: GroupMdCache, overrides?: Partial<Config>): SessionRouter {
    // serverMd on by default here — the refresh path is gated on it.
    return new SessionRouter(makeConfig({ serverMd: true, ...overrides }), ROBOT_ID, '', cache);
  }

  // A GROUP.md change event as it really arrives: on a DM channel, with the
  // affected group carried in event.group_no.
  function mdEvent(overrides?: Partial<BotMessage>): BotMessage {
    return makeMsg({
      channel_type: ChannelType.DM,
      channel_id: 'dm-peer',
      from_uid: 'user-1',
      payload: { type: MessageType.Text, content: '', event: { type: 'group_md_updated', group_no: GROUP } },
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a GROUP.md update event invalidates that group\'s cache (next turn re-fetches) and still returns null', async () => {
    const cache = new GroupMdCache();
    cache.set(GROUP, makeEntry());
    const router = makeRouter(cache);

    const result = await router.route(mdEvent());

    // The event itself never produces a reply.
    expect(result).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    // The cached entry is dropped (keyed by event.group_no, not the DM channel),
    // so the resolver re-fetches the authoritative copy on the next turn.
    expect(cache.get(GROUP)).toBeUndefined();
  });

  it('a join/leave (non-md) system event is dropped WITHOUT invalidating the cache', async () => {
    const cache = new GroupMdCache();
    cache.set(GROUP, makeEntry());
    const router = makeRouter(cache);

    const join = mdEvent({
      payload: { type: MessageType.Text, content: '', event: { type: 'group_member_join', group_no: GROUP } },
    });
    const result = await router.route(join);

    expect(result).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    // Non-md events must NOT be mistaken for an md event — cache is untouched.
    expect(cache.get(GROUP)).toEqual(makeEntry());
  });

  it('an event with no type is dropped and never invalidates', async () => {
    const cache = new GroupMdCache();
    cache.set(GROUP, makeEntry());
    const router = makeRouter(cache);

    const result = await router.route(
      mdEvent({ payload: { type: MessageType.Text, content: '', event: { group_no: GROUP } } }),
    );

    expect(result).toBeNull();
    expect(cache.get(GROUP)).toEqual(makeEntry());
  });

  it('an md event with no group_no on a DM channel is a no-op (no group to target)', async () => {
    const cache = new GroupMdCache();
    cache.set(GROUP, makeEntry());
    const router = makeRouter(cache);

    const result = await router.route(
      mdEvent({ payload: { type: MessageType.Text, content: '', event: { type: 'group_md_updated' } } }),
    );

    expect(result).toBeNull();
    expect(cache.get(GROUP)).toEqual(makeEntry());
  });

  it('with serverMd off the cache is never touched (rollback flag)', async () => {
    const cache = new GroupMdCache();
    cache.set(GROUP, makeEntry());
    const router = makeRouter(cache, { serverMd: false });

    const result = await router.route(mdEvent());

    expect(result).toBeNull();
    expect(cache.get(GROUP)).toEqual(makeEntry());
  });

  it('no cache wired → md event is a harmless no-op (still returns null)', async () => {
    const router = makeRouter(undefined);
    const result = await router.route(mdEvent());
    expect(result).toBeNull();
  });

  it('falls back to the channel group when an md event arrives on a mention-free group with no group_no', async () => {
    const cache = new GroupMdCache();
    cache.set(GROUP, makeEntry());
    // Mention-free is the one group path that reaches the event branch (the
    // mention gate otherwise drops un-mentioned group messages). A composite
    // thread channel_id normalizes to its parent group.
    const router = makeRouter(cache, { mentionFreeGroups: [`${GROUP}____thread-1`] });

    const result = await router.route(
      mdEvent({
        channel_type: ChannelType.CommunityTopic,
        channel_id: `${GROUP}____thread-1`,
        payload: { type: MessageType.Text, content: '', event: { type: 'group_md_updated' } },
      }),
    );

    expect(result).toBeNull();
    expect(cache.get(GROUP)).toBeUndefined();
  });

  it('the md event literal is overridable via serverMdEventTypes (calibration seam)', async () => {
    const cache = new GroupMdCache();
    cache.set(GROUP, makeEntry());
    // The provisional default literal no longer matches; a real captured literal does.
    const router = makeRouter(cache, { serverMdEventTypes: ['group.md.changed'] });

    // Default literal is now ignored.
    await router.route(mdEvent());
    expect(cache.get(GROUP)).toEqual(makeEntry());

    // The configured literal triggers invalidation.
    const real = mdEvent({
      payload: { type: MessageType.Text, content: '', event: { type: 'group.md.changed', group_no: GROUP } },
    });
    await router.route(real);
    expect(cache.get(GROUP)).toBeUndefined();
  });

  it('a GROUP.md DELETE event also invalidates the cache (P3-2 deleted-event tail)', async () => {
    const cache = new GroupMdCache();
    cache.set(GROUP, makeEntry());
    const router = makeRouter(cache);

    const result = await router.route(
      mdEvent({ payload: { type: MessageType.Text, content: '', event: { type: 'group_md_deleted', group_no: GROUP } } }),
    );

    expect(result).toBeNull();
    // A server-side delete drops the cached copy → next read 404s → local fallback.
    expect(cache.get(GROUP)).toBeUndefined();
  });
});

// P3-2: THREAD.md event-driven cache refresh. Mirrors the P2-B group block, but
// keyed by the COMPOSITE groupNo::shortId and gated on `threadMd`. Verifies the
// routing (thread md event → invalidate the right subarea; group events and
// missing short_id → never touch the thread cache) and the config-override seam.
describe('SessionRouter — THREAD.md event-driven cache refresh (P3-2)', () => {
  const GROUP = 'group-abc';
  const SHORT = '2071488441815666688';

  function makeEntry(): GroupMdEntry {
    return { content: '# cached thread', version: 1, updated_at: null };
  }

  function makeRouter(cache?: ThreadMdCache, overrides?: Partial<Config>): SessionRouter {
    // threadMd on by default here — the thread refresh path is gated on it. The
    // group cache is passed undefined; this block exercises the thread path only.
    return new SessionRouter(makeConfig({ threadMd: true, ...overrides }), ROBOT_ID, '', undefined, cache);
  }

  // A THREAD.md change event as it really arrives: on a DM channel, with the
  // affected thread carried in event.group_no + event.short_id.
  function threadEvent(overrides?: Partial<BotMessage>): BotMessage {
    return makeMsg({
      channel_type: ChannelType.DM,
      channel_id: 'dm-peer',
      from_uid: 'user-1',
      payload: {
        type: MessageType.Text,
        content: '',
        event: { type: 'thread_md_updated', group_no: GROUP, short_id: SHORT },
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a THREAD.md update event invalidates that subarea\'s composite-keyed cache and returns null', async () => {
    const cache = new ThreadMdCache();
    cache.set(GROUP, SHORT, makeEntry());
    const router = makeRouter(cache);

    const result = await router.route(threadEvent());

    expect(result).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(cache.get(GROUP, SHORT)).toBeUndefined();
  });

  it('a THREAD.md DELETE event also invalidates the subarea cache', async () => {
    const cache = new ThreadMdCache();
    cache.set(GROUP, SHORT, makeEntry());
    const router = makeRouter(cache);

    await router.route(
      threadEvent({
        payload: { type: MessageType.Text, content: '', event: { type: 'thread_md_deleted', group_no: GROUP, short_id: SHORT } },
      }),
    );

    expect(cache.get(GROUP, SHORT)).toBeUndefined();
  });

  it('only the targeted subarea is dropped — a sibling thread under the same group survives', async () => {
    const cache = new ThreadMdCache();
    cache.set(GROUP, SHORT, makeEntry());
    cache.set(GROUP, 'sibling', makeEntry());
    const router = makeRouter(cache);

    await router.route(threadEvent());

    expect(cache.get(GROUP, SHORT)).toBeUndefined();
    expect(cache.get(GROUP, 'sibling')).toEqual(makeEntry()); // untouched
  });

  it('a GROUP.md event never touches the thread cache (disjoint literals / mutual exclusion)', async () => {
    const cache = new ThreadMdCache();
    cache.set(GROUP, SHORT, makeEntry());
    const router = makeRouter(cache);

    await router.route(
      threadEvent({
        payload: { type: MessageType.Text, content: '', event: { type: 'group_md_updated', group_no: GROUP, short_id: SHORT } },
      }),
    );

    // A group-md literal must not invalidate a thread entry.
    expect(cache.get(GROUP, SHORT)).toEqual(makeEntry());
  });

  it('a thread event with no short_id is a no-op (no subarea to key)', async () => {
    const cache = new ThreadMdCache();
    cache.set(GROUP, SHORT, makeEntry());
    const router = makeRouter(cache);

    await router.route(
      threadEvent({ payload: { type: MessageType.Text, content: '', event: { type: 'thread_md_updated', group_no: GROUP } } }),
    );

    expect(cache.get(GROUP, SHORT)).toEqual(makeEntry());
  });

  it('with threadMd off the thread cache is never touched (rollback flag)', async () => {
    const cache = new ThreadMdCache();
    cache.set(GROUP, SHORT, makeEntry());
    const router = makeRouter(cache, { threadMd: false });

    await router.route(threadEvent());

    expect(cache.get(GROUP, SHORT)).toEqual(makeEntry());
  });

  it('no thread cache wired → thread md event is a harmless no-op (returns null)', async () => {
    const router = makeRouter(undefined);
    const result = await router.route(threadEvent());
    expect(result).toBeNull();
  });

  it('derives groupNo + shortId from the channel on a mention-free thread with no ids in the event', async () => {
    const cache = new ThreadMdCache();
    cache.set(GROUP, SHORT, makeEntry());
    // Mention-free is the one group-like path that reaches the event branch.
    const router = makeRouter(cache, { mentionFreeGroups: [`${GROUP}____${SHORT}`] });

    await router.route(
      threadEvent({
        channel_type: ChannelType.CommunityTopic,
        channel_id: `${GROUP}____${SHORT}`,
        payload: { type: MessageType.Text, content: '', event: { type: 'thread_md_updated' } },
      }),
    );

    expect(cache.get(GROUP, SHORT)).toBeUndefined();
  });

  it('the thread md event literal is overridable via threadMdEventTypes (calibration seam)', async () => {
    const cache = new ThreadMdCache();
    cache.set(GROUP, SHORT, makeEntry());
    const router = makeRouter(cache, { threadMdEventTypes: ['thread.md.changed'] });

    // Default provisional literal is now ignored.
    await router.route(threadEvent());
    expect(cache.get(GROUP, SHORT)).toEqual(makeEntry());

    // The configured literal triggers invalidation.
    await router.route(
      threadEvent({
        payload: { type: MessageType.Text, content: '', event: { type: 'thread.md.changed', group_no: GROUP, short_id: SHORT } },
      }),
    );
    expect(cache.get(GROUP, SHORT)).toBeUndefined();
  });
});
