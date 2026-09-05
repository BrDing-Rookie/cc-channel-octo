/**
 * A4: interactive-card tool — fail-closed gate (disabled policy is a hard error),
 * graceful plain-text degrade when interaction is unsupported, runtime-owned
 * delivery target, and card-session registration on a real interactive send.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (opts: { name: string }) => ({ type: 'sdk', name: opts.name, instance: {} }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

vi.mock('../octo/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../octo/api.js')>();
  return { ...actual, getCardProfile: vi.fn(), sendCardMessage: vi.fn(), sendMessage: vi.fn() };
});

import {
  buildInteractiveCardTools,
  createInteractiveCardToolServer,
  INTERACTIVE_CARD_TOOL_NAME,
  INTERACTIVE_CARD_TOOL_SERVER_NAME,
  type InteractiveCardSessionCoords,
} from '../card-interactive-tool.js';
import { ChannelType, type CardProfileManifest } from '../octo/types.js';
import { getCardProfile, sendCardMessage, sendMessage } from '../octo/api.js';
import { lookupCardSession, _resetCardSessionsForTests } from '../card-session.js';

const mockGetProfile = vi.mocked(getCardProfile);
const mockSendCard = vi.mocked(sendCardMessage);
const mockSendMessage = vi.mocked(sendMessage);

const CONFIG = { apiUrl: 'https://octo.example.com', botToken: 'tok', accountId: 'bot-1' };

function coords(over: Partial<InteractiveCardSessionCoords> = {}): InteractiveCardSessionCoords {
  return { channelId: 'grp-9', channelType: ChannelType.Group, ...over };
}

function manifest(over: Partial<CardProfileManifest> = {}): CardProfileManifest {
  return {
    available: true,
    enabled: true,
    profiles: ['octo/v1', 'octo/v2'],
    card_version: '1.5',
    elements: ['TextBlock', 'Container', 'FactSet', 'Input.ChoiceSet'],
    inputs: ['Input.Text', 'Input.ChoiceSet'],
    actions: [],
    limits: {},
    config: {
      card_enabled: true,
      display_enabled: true,
      interaction_enabled: true,
      reasoning_enabled: false,
      reasoning_template_ref: null,
    },
    ...over,
  } as CardProfileManifest;
}

function getTool(c: InteractiveCardSessionCoords, sessionKey?: string) {
  const t = buildInteractiveCardTools(CONFIG, c, sessionKey).find((x) => x.name === INTERACTIVE_CARD_TOOL_NAME);
  if (!t) throw new Error('tool not found');
  return t as { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }> };
}
function text(r: { content: Array<{ text?: string }> }): string {
  return r.content.map((c) => c.text ?? '').join('');
}

const ARGS = { title: 'Approve deploy?', buttons: [{ id: 'yes', label: 'Approve' }, { id: 'no', label: 'Reject' }] };

describe('card-interactive-tool', () => {
  beforeEach(() => {
    _resetCardSessionsForTests();
    mockGetProfile.mockReset();
    mockSendCard.mockReset();
    mockSendMessage.mockReset();
    mockSendCard.mockResolvedValue({ message_id: 'card-msg-1' } as never);
    mockSendMessage.mockResolvedValue({ message_id: 'plain-1' } as never);
  });

  it('server is named "send_card"', () => {
    expect(createInteractiveCardToolServer(CONFIG, coords()).name).toBe(INTERACTIVE_CARD_TOOL_SERVER_NAME);
  });

  it('hard-errors when the Bot policy disables interaction (no plain-text spam)', async () => {
    mockGetProfile.mockResolvedValue(manifest({ config: { card_enabled: true, display_enabled: true, interaction_enabled: false, reasoning_enabled: false, reasoning_template_ref: null } }));
    const r = await getTool(coords()).handler(ARGS, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/disabled by the server Bot policy/);
    expect(mockSendCard).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('sends a real interactive card to the runtime-owned channel and registers the session', async () => {
    mockGetProfile.mockResolvedValue(manifest());
    const r = await getTool(coords(), 'sess-key-1').handler(ARGS, {});
    expect(r.isError).toBeUndefined();
    expect(mockSendCard).toHaveBeenCalledTimes(1);
    const call = mockSendCard.mock.calls[0][0];
    expect(call.channelId).toBe('grp-9'); // from coords, never tool args
    expect(call.profile).toBe('octo/v2');
    const sess = lookupCardSession('card-msg-1');
    expect(sess).not.toBeNull();
    expect(sess!.accountId).toBe('bot-1');
    expect(sess!.channelId).toBe('grp-9');
    expect(sess!.sessionKey).toBe('sess-key-1');
    expect(sess!.actionLabels).toEqual({ yes: 'Approve', no: 'Reject' });
  });

  it('degrades to plain text (no card, no session) when octo/v2 is not advertised', async () => {
    mockGetProfile.mockResolvedValue(manifest({ profiles: ['octo/v1'] }));
    const r = await getTool(coords()).handler(ARGS, {});
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/degraded/);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendCard).not.toHaveBeenCalled();
    expect(mockSendMessage.mock.calls[0][0].channelId).toBe('grp-9');
  });

  it('rejects author content that fails the pure builder before any wire call', async () => {
    mockGetProfile.mockResolvedValue(manifest());
    const r = await getTool(coords()).handler({ title: 'Approve deploy AKIAIOSFODNN7EXAMPLE', buttons: ARGS.buttons }, {});
    expect(r.isError).toBe(true);
    expect(mockGetProfile).not.toHaveBeenCalled(); // baseline build fails first
    expect(mockSendCard).not.toHaveBeenCalled();
  });
});
