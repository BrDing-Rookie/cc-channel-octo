import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Octo API: sendMessage (used by replySafe) + getMentionPref (F1 gate).
vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  getMentionPref: vi.fn(),
}));

import { SessionRouter, type RobotFlagLookup } from '../session-router.js';
import type { BotMessage } from '../octo/types.js';
import { ChannelType, MessageType } from '../octo/types.js';
import type { Config } from '../config.js';
import { getMentionPref, type MentionPref } from '../octo/api.js';
import { MentionPrefCache } from '../mention-pref-cache.js';

const ROBOT_ID = 'bot-001';
const mockGetMentionPref = vi.mocked(getMentionPref);

const FREE: MentionPref = { no_mention: true, group_allow_no_mention: true, effective: true };
const NOT_FREE: MentionPref = { no_mention: false, group_allow_no_mention: true, effective: false };

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp',
    dataDir: '/tmp/data',
    sdk: { allowedTools: [], permissionMode: 'bypassPermissions', settingSources: ['user'] },
    rateLimit: { maxPerMinute: 1000 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    ...overrides,
  };
}

function makeMsg(overrides?: Partial<BotMessage>): BotMessage {
  return {
    message_id: '1',
    message_seq: 1,
    from_uid: 'human-1',
    channel_id: 'g1',
    channel_type: ChannelType.Group,
    timestamp: Date.now(),
    payload: { type: MessageType.Text, content: 'hello' },
    ...overrides,
  };
}

/**
 * Build a router wired for F1. `robot` maps uid → robot flag (undefined = unknown,
 * i.e. roster not yet warmed). Returns the router plus a helper that runs a message
 * through the gate and reports whether it was accepted for processing.
 */
function makeRouter(
  cfg: Partial<Config>,
  robot: Record<string, boolean | undefined> = {},
): { router: SessionRouter; run: (m: BotMessage) => Promise<boolean> } {
  const cache = new MentionPrefCache();
  const lookup: RobotFlagLookup = (_channelId, uid) =>
    Object.prototype.hasOwnProperty.call(robot, uid) ? robot[uid] : undefined;
  const router = new SessionRouter(makeConfig(cfg), ROBOT_ID, '', undefined, undefined, cache, lookup);
  return {
    router,
    run: async (m) => {
      let processed = false;
      await router.routeAndHandle(m, async () => {
        processed = true;
      });
      return processed;
    },
  };
}

describe('F1 — server-authoritative mention-free gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMentionPref.mockResolvedValue(NOT_FREE);
  });

  it('relaxes @-mention for a HUMAN sender when the server pref is effective', async () => {
    mockGetMentionPref.mockResolvedValue(FREE);
    const { run } = makeRouter({ serverMentionPref: true }, { 'human-1': false });
    expect(await run(makeMsg({ from_uid: 'human-1' }))).toBe(true);
    expect(mockGetMentionPref).toHaveBeenCalledWith(
      expect.objectContaining({ groupNo: 'g1', botToken: 'test-token' }),
    );
  });

  it('does NOT relax for a bot sender even when the pref is effective (F1 red line)', async () => {
    mockGetMentionPref.mockResolvedValue(FREE);
    // Confirmed-robot flag, uid does not even match the _bot heuristic.
    const { run } = makeRouter({ serverMentionPref: true }, { 'relay-uid': true });
    expect(await run(makeMsg({ from_uid: 'relay-uid' }))).toBe(false);
    // The pref lookup is short-circuited before any network call for a bot sender.
    expect(mockGetMentionPref).not.toHaveBeenCalled();
  });

  it('does NOT relax for an unknown sender whose uid matches the _bot heuristic', async () => {
    mockGetMentionPref.mockResolvedValue(FREE);
    const { run } = makeRouter({ serverMentionPref: true }); // no robot flags → unknown
    expect(await run(makeMsg({ from_uid: 'sidekick_bot' }))).toBe(false);
    expect(mockGetMentionPref).not.toHaveBeenCalled();
  });

  it('relaxes for an unknown (roster-cold) sender that does not look like a bot', async () => {
    mockGetMentionPref.mockResolvedValue(FREE);
    const { run } = makeRouter({ serverMentionPref: true }); // 'newcomer' flag unknown
    expect(await run(makeMsg({ from_uid: 'newcomer' }))).toBe(true);
  });

  it('does NOT relax when the pref is not effective (fail-closed to @-required)', async () => {
    mockGetMentionPref.mockResolvedValue(NOT_FREE);
    const { run } = makeRouter({ serverMentionPref: true }, { 'human-1': false });
    expect(await run(makeMsg({ from_uid: 'human-1' }))).toBe(false);
  });

  it('with the flag off, the server pref is never consulted (only the static list)', async () => {
    const { run } = makeRouter({ serverMentionPref: false }, { 'human-1': false });
    expect(await run(makeMsg({ from_uid: 'human-1' }))).toBe(false);
    expect(mockGetMentionPref).not.toHaveBeenCalled();
  });

  it('the legacy static mentionFreeGroups list still relaxes (unchanged)', async () => {
    const { run } = makeRouter({ serverMentionPref: true, mentionFreeGroups: ['g1'] }, { 'human-1': false });
    expect(await run(makeMsg({ from_uid: 'human-1' }))).toBe(true);
    // Static-list hit short-circuits before the server pref is fetched.
    expect(mockGetMentionPref).not.toHaveBeenCalled();
  });

  it('an explicit @-mention always triggers, bypassing the mention-free gate', async () => {
    const { run } = makeRouter({ serverMentionPref: true }, { 'relay-uid': true });
    const msg = makeMsg({ from_uid: 'relay-uid', payload: { type: MessageType.Text, content: 'hi', mention: { uids: [ROBOT_ID] } } });
    expect(await run(msg)).toBe(true);
  });

  it('caches the pref: two messages in the same group fetch once', async () => {
    mockGetMentionPref.mockResolvedValue(FREE);
    const { run } = makeRouter({ serverMentionPref: true }, { 'human-1': false });
    await run(makeMsg({ message_id: '1', from_uid: 'human-1' }));
    await run(makeMsg({ message_id: '2', from_uid: 'human-1' }));
    expect(mockGetMentionPref).toHaveBeenCalledTimes(1);
  });
});

describe('F1 — mention_pref_updated event invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a mention_pref_updated event drops the cached pref, forcing a re-fetch', async () => {
    mockGetMentionPref.mockResolvedValue(FREE);
    const { router, run } = makeRouter({ serverMentionPref: true }, { 'human-1': false });

    await run(makeMsg({ message_id: '1', from_uid: 'human-1' }));
    expect(mockGetMentionPref).toHaveBeenCalledTimes(1);

    // Deliver a mention-pref change event for g1 (arrives on a system/DM channel).
    await router.routeAndHandle(
      makeMsg({
        message_id: 'evt',
        channel_type: ChannelType.DM,
        from_uid: 'system',
        payload: { type: MessageType.Text, content: '', event: { type: 'mention_pref_updated', group_no: 'g1' } },
      }),
      async () => {
        throw new Error('a system event must never reach the handler');
      },
    );

    // Next turn re-fetches the authoritative pref.
    await run(makeMsg({ message_id: '2', from_uid: 'human-1' }));
    expect(mockGetMentionPref).toHaveBeenCalledTimes(2);
  });

  it('an unrelated system event does not invalidate the pref cache', async () => {
    mockGetMentionPref.mockResolvedValue(FREE);
    const { router, run } = makeRouter({ serverMentionPref: true }, { 'human-1': false });

    await run(makeMsg({ message_id: '1', from_uid: 'human-1' }));
    await router.routeAndHandle(
      makeMsg({
        message_id: 'evt',
        channel_type: ChannelType.DM,
        from_uid: 'system',
        payload: { type: MessageType.Text, content: '', event: { type: 'member_joined', group_no: 'g1' } },
      }),
      async () => {},
    );
    await run(makeMsg({ message_id: '2', from_uid: 'human-1' }));
    // Still cached from the first fetch — the unrelated event left it intact.
    expect(mockGetMentionPref).toHaveBeenCalledTimes(1);
  });
});
