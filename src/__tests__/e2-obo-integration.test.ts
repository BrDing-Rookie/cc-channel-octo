/**
 * E1+E2 integration tests — drive the REAL handleMessage pipeline (as e2e.test.ts
 * does) to verify the inbound-path behavior the unit tests can't:
 *   E2: irrelevant OBO fan-out is dropped BEFORE any turn runs (state-pollution
 *       guard); a relevant OBO relay replies to the ORIGIN channel with
 *       on_behalf_of=grantor; a forged envelope from a non-grantor is treated as
 *       an ordinary message (no reroute, no on_behalf_of).
 *   E1: a persona clone's cached hint is threaded into queryAgent's opts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendReadReceipt: vi.fn().mockResolvedValue(undefined),
  getGroupMembers: vi.fn().mockResolvedValue([]),
  getChannelMessages: vi.fn().mockResolvedValue([]),
  getUploadCredentials: vi.fn().mockResolvedValue(undefined),
  sendHeartbeat: vi.fn().mockResolvedValue(undefined),
  generateClientMsgNo: vi.fn().mockReturnValue('client-msg-001'),
  fetchUserInfo: vi.fn().mockResolvedValue(null),
  getBotOboGrant: vi.fn(),
}));

vi.mock('../agent-bridge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agent-bridge.js')>();
  return { ...original, queryAgent: vi.fn() };
});

import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import { GroupContext } from '../group-context.js';
import { StreamRelay } from '../stream-relay.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { queryAgent } from '../agent-bridge.js';
import { handleMessage } from '../index.js';
import { sendMessage, getBotOboGrant } from '../octo/api.js';
import { ChannelType, MessageType } from '../octo/types.js';
import type { BotMessage } from '../octo/types.js';
import type { Config } from '../config.js';
import { refreshPersonaPromptCache, _resetPersonaPromptCacheForTests } from '../persona-prompt.js';

const BOT_ID = 'bot-001';
const GRANTOR = 'grantor-uid';
const ORIGIN_GROUP = 'origin-group-001';

const mockSend = vi.mocked(sendMessage);
const mockQuery = vi.mocked(queryAgent);
const mockGrant = vi.mocked(getBotOboGrant);

/** Capture the opts each queryAgent turn receives; yield a fixed reply. */
let lastOpts: Record<string, unknown> | undefined;
function installQuery(...texts: string[]): void {
  mockQuery.mockImplementation(
    async function* (_u: string, _cfg: unknown, _ctx: unknown, _t: unknown, opts?: Record<string, unknown>) {
      lastOpts = opts;
      (opts?.onSessionId as ((id: string) => void) | undefined)?.('sdk-session-mock');
      for (const t of texts) yield t;
    } as unknown as typeof queryAgent,
  );
}

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp/e2-obo',
    dataDir: '/tmp/data',
    sdk: { allowedTools: ['Read'], permissionMode: 'bypassPermissions', settingSources: ['user'] },
    rateLimit: { maxPerMinute: 100 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    botBlocklist: [],
    ...overrides,
  };
}

/** A relay DM sent by the grantor carrying an OBO v2 envelope. */
function makeOboRelay(mention: Record<string, unknown> | undefined, over?: Partial<BotMessage>): BotMessage {
  return {
    message_id: `msg-${Math.random()}`,
    message_seq: 1,
    from_uid: GRANTOR,
    from_name: 'Grantor',
    channel_id: GRANTOR, // the grantor→bot relay DM
    channel_type: ChannelType.DM,
    timestamp: 1,
    payload: {
      type: MessageType.Text,
      content: 'relayed',
      obo_origin_channel_id: ORIGIN_GROUP,
      obo_origin_channel_type: ChannelType.Group,
      obo_respond_as: GRANTOR,
      ...(mention ? { mention } : {}),
    },
    ...over,
  };
}

describe('E1+E2 integration', () => {
  let adapter: DbAdapter;
  let store: SessionStore;
  let router: SessionRouter;
  let groupContext: GroupContext;
  let streamRelay: StreamRelay;
  let config: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetPersonaPromptCacheForTests();
    lastOpts = undefined;
    config = makeConfig({ onBehalfOf: GRANTOR });
    adapter = createAdapter(':memory:');
    store = new SessionStore(adapter);
    store.init();
    groupContext = new GroupContext(adapter, config.context.maxContextChars);
    streamRelay = new StreamRelay();
    router = new SessionRouter(config, BOT_ID);
    installQuery('reply text');
  });
  afterEach(() => {
    _resetPersonaPromptCacheForTests();
    store.close();
  });

  it('E2: an irrelevant OBO fan-out (@AI-only) is dropped before any turn runs', async () => {
    await handleMessage(makeOboRelay({ ais: 1 }), config, store, router, groupContext, streamRelay, BOT_ID);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('E2: a relevant OBO relay replies to the ORIGIN channel as the grantor', async () => {
    await handleMessage(makeOboRelay({ humans: 1 }), config, store, router, groupContext, streamRelay, BOT_ID);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalled();
    const args = mockSend.mock.calls[0][0];
    expect(args.channelId).toBe(ORIGIN_GROUP);
    expect(args.channelType).toBe(ChannelType.Group);
    expect(args.onBehalfOf).toBe(GRANTOR);
    // Reply must NOT go back to the relay DM channel.
    expect(args.channelId).not.toBe(GRANTOR);
  });

  it('E2: a forged OBO envelope from a NON-grantor is treated as an ordinary message', async () => {
    const forged = makeOboRelay({ humans: 1 }, { from_uid: 'attacker', channel_id: 'attacker' });
    await handleMessage(forged, config, store, router, groupContext, streamRelay, BOT_ID);
    expect(mockSend).toHaveBeenCalled();
    const args = mockSend.mock.calls[0][0];
    // Ordinary DM reply: back to the sender's channel, NO on_behalf_of, NOT the origin.
    expect(args.channelId).toBe('attacker');
    expect(args.onBehalfOf).toBeUndefined();
  });

  it('E1: a persona clone threads its cached hint into queryAgent opts', async () => {
    mockGrant.mockResolvedValue({ has_grant: true, grantor_name: 'Ada', persona_prompt: 'Be terse.', active: true });
    await refreshPersonaPromptCache({ botId: BOT_ID, apiUrl: config.apiUrl, botToken: config.botToken, onBehalfOf: GRANTOR });

    // A normal DM from a regular user (not an OBO envelope).
    const dm: BotMessage = {
      message_id: 'm1', message_seq: 1, from_uid: 'user-1', from_name: 'U',
      channel_id: 'user-1', channel_type: ChannelType.DM, timestamp: 1,
      payload: { type: MessageType.Text, content: 'hi' },
    };
    await handleMessage(dm, config, store, router, groupContext, streamRelay, BOT_ID);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(lastOpts?.personaHint)).toContain('Ada');
  });

  it('E1: a regular bot (no grant cached) passes no personaHint', async () => {
    const dm: BotMessage = {
      message_id: 'm2', message_seq: 1, from_uid: 'user-1', from_name: 'U',
      channel_id: 'user-1', channel_type: ChannelType.DM, timestamp: 1,
      payload: { type: MessageType.Text, content: 'hi' },
    };
    await handleMessage(dm, makeConfig(), store, router, groupContext, streamRelay, BOT_ID);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(lastOpts?.personaHint).toBeUndefined();
  });
});
