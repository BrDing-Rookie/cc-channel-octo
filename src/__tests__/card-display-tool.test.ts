/**
 * A9: display-card tool tests — fail-closed gate, runtime-owned target, bot-only
 * identity, and integration with the A3 build/desensitize path.
 *
 * The tool handler is driven directly via `buildDisplayCardTools` (the MCP server
 * keeps its tools private). The SDK's `tool`/`createSdkMcpServer` are mocked to
 * plain passthroughs; only the two wire calls (`getCardProfile`, `sendCardMessage`)
 * are stubbed — `deriveCardCaps`, `buildDisplayCard`, and `validateDisplayBlocks`
 * run for real so the desensitization / negotiation path is exercised end to end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (opts: { name: string }) => ({ type: 'sdk', name: opts.name, instance: {} }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

vi.mock('../octo/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../octo/api.js')>();
  return { ...actual, getCardProfile: vi.fn(), sendCardMessage: vi.fn() };
});

import {
  buildDisplayCardTools,
  createDisplayCardToolServer,
  displayCardGateReason,
  DISPLAY_CARD_TOOL_SERVER_NAME,
  DISPLAY_CARD_TOOL_NAME,
  type DisplayCardSessionCoords,
} from '../card-display-tool.js';
import { ChannelType, type CardProfileManifest } from '../octo/types.js';
import { getCardProfile, sendCardMessage } from '../octo/api.js';

const mockGetCardProfile = vi.mocked(getCardProfile);
const mockSendCardMessage = vi.mocked(sendCardMessage);

const CONFIG = { apiUrl: 'https://octo.example.com', botToken: 'bot-token' };

function coords(over: Partial<DisplayCardSessionCoords> = {}): DisplayCardSessionCoords {
  return { channelId: 'grp-9', channelType: ChannelType.Group, ...over };
}

/** A manifest that PASSES the fail-closed gate. */
function goodManifest(over: Partial<CardProfileManifest> = {}): CardProfileManifest {
  return {
    available: true,
    enabled: true,
    profiles: ['octo/v1'],
    card_version: '1.5',
    elements: ['TextBlock', 'Container', 'ColumnSet', 'FactSet', 'RichTextBlock', 'Table'],
    actions: [],
    limits: {},
    config: {
      card_enabled: true,
      display_enabled: true,
      interaction_enabled: false,
      reasoning_enabled: false,
      reasoning_template_ref: null,
    },
    ...over,
  } as CardProfileManifest;
}

function getTool(c: DisplayCardSessionCoords, config = CONFIG) {
  const t = buildDisplayCardTools(config, c).find((x) => x.name === DISPLAY_CARD_TOOL_NAME);
  if (!t) throw new Error('display-card tool not found');
  return t as { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }> };
}
function text(r: { content: Array<{ text?: string }> }): string {
  return r.content.map((c) => c.text ?? '').join('');
}

describe('card-display-tool', () => {
  beforeEach(() => {
    mockGetCardProfile.mockReset();
    mockSendCardMessage.mockReset();
    mockSendCardMessage.mockResolvedValue({ message_id: 'msg-1' } as never);
  });

  it('createDisplayCardToolServer builds an MCP server named "display_card"', () => {
    const s = createDisplayCardToolServer(CONFIG, coords());
    expect(DISPLAY_CARD_TOOL_SERVER_NAME).toBe('display_card');
    expect(DISPLAY_CARD_TOOL_NAME).toBe('octo_send_display_card');
    expect((s as { name: string }).name).toBe('display_card');
  });

  it('happy path: posts a card to the session channel and reports the message id', async () => {
    mockGetCardProfile.mockResolvedValue(goodManifest());
    const r = await getTool(coords()).handler(
      { title: 'Deploy status', blocks: [{ type: 'text', text: 'All green' }] },
      {},
    );
    expect(r.isError).toBeFalsy();
    expect(mockSendCardMessage).toHaveBeenCalledTimes(1);
    const sent = mockSendCardMessage.mock.calls[0]![0];
    expect(sent.channelId).toBe('grp-9');
    expect(sent.channelType).toBe(ChannelType.Group);
    expect(text(r)).toContain('msg-1');
  });

  it('identity is always the bot: no on_behalf_of is ever forwarded', async () => {
    mockGetCardProfile.mockResolvedValue(goodManifest());
    // Even if the model tries to smuggle an identity, it is ignored.
    await getTool(coords()).handler(
      { blocks: [{ type: 'text', text: 'hi' }], onBehalfOf: 'someone-else', on_behalf_of: 'x' },
      {},
    );
    const sent = mockSendCardMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.onBehalfOf).toBeUndefined();
    expect(sent.on_behalf_of).toBeUndefined();
  });

  it('target is runtime-owned: a channelId in tool args is ignored', async () => {
    mockGetCardProfile.mockResolvedValue(goodManifest());
    await getTool(coords({ channelId: 'real-chan' })).handler(
      { blocks: [{ type: 'text', text: 'hi' }], channelId: 'attacker-chan', channel_id: 'attacker-chan' },
      {},
    );
    expect(mockSendCardMessage.mock.calls[0]![0].channelId).toBe('real-chan');
  });

  it('fail-closed: display disabled by server Bot policy → rejected, nothing sent', async () => {
    mockGetCardProfile.mockResolvedValue(goodManifest({
      config: {
        card_enabled: true,
        display_enabled: false,
        interaction_enabled: false,
        reasoning_enabled: false,
        reasoning_template_ref: null,
      },
    } as Partial<CardProfileManifest>));
    const r = await getTool(coords()).handler({ blocks: [{ type: 'text', text: 'x' }] }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('disabled by the server Bot policy');
    expect(mockSendCardMessage).not.toHaveBeenCalled();
  });

  it('fail-closed: manifest unavailable (endpoint 404) → rejected', async () => {
    mockGetCardProfile.mockResolvedValue({ available: false, enabled: false });
    const r = await getTool(coords()).handler({ blocks: [{ type: 'text', text: 'x' }] }, {});
    expect(r.isError).toBe(true);
    expect(mockSendCardMessage).not.toHaveBeenCalled();
  });

  it('fail-closed: octo/v1 profile not advertised → rejected', async () => {
    mockGetCardProfile.mockResolvedValue(goodManifest({ profiles: ['octo/v2'] }));
    const r = await getTool(coords()).handler({ blocks: [{ type: 'text', text: 'x' }] }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not advertised');
    expect(mockSendCardMessage).not.toHaveBeenCalled();
  });

  it('fail-closed: incompatible card_version → rejected', async () => {
    mockGetCardProfile.mockResolvedValue(goodManifest({ card_version: '1.4' }));
    const r = await getTool(coords()).handler({ blocks: [{ type: 'text', text: 'x' }] }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not compatible');
    expect(mockSendCardMessage).not.toHaveBeenCalled();
  });

  it('fail-closed: TextBlock not advertised → rejected', async () => {
    mockGetCardProfile.mockResolvedValue(goodManifest({ elements: ['Container'] }));
    const r = await getTool(coords()).handler({ blocks: [{ type: 'text', text: 'x' }] }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('TextBlock');
    expect(mockSendCardMessage).not.toHaveBeenCalled();
  });

  it('fail-closed: profile probe throws (transport/5xx) → rejected, nothing sent', async () => {
    mockGetCardProfile.mockRejectedValue(new Error('boom'));
    const r = await getTool(coords()).handler({ blocks: [{ type: 'text', text: 'x' }] }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('card profile probe failed');
    expect(mockSendCardMessage).not.toHaveBeenCalled();
  });

  it('empty blocks (nothing valid after validation) → rejected before send', async () => {
    mockGetCardProfile.mockResolvedValue(goodManifest());
    const r = await getTool(coords()).handler({ blocks: [{ type: 'bogus' }, { nope: 1 }] }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('empty');
    expect(mockSendCardMessage).not.toHaveBeenCalled();
  });

  it('desensitizes content via the A3 build path: secrets never reach the wire', async () => {
    mockGetCardProfile.mockResolvedValue(goodManifest());
    await getTool(coords()).handler(
      {
        blocks: [
          { type: 'text', text: 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
          { type: 'text', text: 'ok line' },
        ],
      },
      {},
    );
    const sent = mockSendCardMessage.mock.calls[0]![0];
    const serialized = JSON.stringify(sent.card) + (sent.plain ?? '');
    expect(serialized).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(serialized).toContain('ok line');
  });

  it('unconfigured account → error, nothing sent', async () => {
    const r = await getTool(coords(), { apiUrl: '', botToken: '' }).handler(
      { blocks: [{ type: 'text', text: 'x' }] },
      {},
    );
    expect(r.isError).toBe(true);
    expect(mockGetCardProfile).not.toHaveBeenCalled();
    expect(mockSendCardMessage).not.toHaveBeenCalled();
  });

  describe('displayCardGateReason', () => {
    it('passes a fully-advertised manifest', () => {
      expect(displayCardGateReason(goodManifest())).toBeNull();
    });
    it('rejects when unavailable', () => {
      expect(displayCardGateReason({ available: false, enabled: false })).toBeTruthy();
    });
  });
});
