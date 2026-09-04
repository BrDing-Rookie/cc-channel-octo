/**
 * C1/C2 tool-shell tests: octo_send_media / octo_send_rich_text bind delivery to
 * the trusted per-turn coords (never tool args), send as the bot itself, and
 * fail-guard on an unconfigured account. The orchestration is mocked — this
 * verifies the shell's routing + guards only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK so `tool()` returns a plain { name, handler } we can drive directly.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (opts: { name: string }) => ({ type: 'sdk', name: opts.name, instance: {} }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

const sendMediaToChannel = vi.fn();
const sendRichTextToChannel = vi.fn();

vi.mock('../media-outbound.js', () => ({
  sendMediaToChannel: (...a: unknown[]) => sendMediaToChannel(...a),
  sendRichTextToChannel: (...a: unknown[]) => sendRichTextToChannel(...a),
}));

import {
  buildMediaSendTools,
  SEND_MEDIA_TOOL_NAME,
  SEND_RICH_TEXT_TOOL_NAME,
  type MediaSendSessionCoords,
  type MediaSendToolConfig,
} from '../media-send-tool.js';
import { ChannelType } from '../octo/types.js';

const CONFIG: MediaSendToolConfig = { apiUrl: 'https://test.example.com', botToken: 'bf_test' };
const COORDS: MediaSendSessionCoords = { channelId: 'g1', channelType: ChannelType.Group, cwdDir: '/tmp/sandbox' };

/** Invoke a built tool's handler by name. */
async function invoke(tools: ReturnType<typeof buildMediaSendTools>, name: string, args: Record<string, unknown>) {
  const t = tools.find((x) => (x as { name: string }).name === name) as unknown as {
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  };
  return t.handler(args, {});
}

beforeEach(() => {
  sendMediaToChannel.mockReset();
  sendRichTextToChannel.mockReset();
  sendMediaToChannel.mockResolvedValue({ messageId: 'm1', url: 'u', type: 'image', filename: 'x.png', size: 1, width: 2, height: 3 });
  sendRichTextToChannel.mockResolvedValue({ messageId: 'r1', imageCount: 1, failedMedia: [], richText: true });
});

describe('octo_send_media', () => {
  it('routes to the runtime-owned channel + cwd, never tool args', async () => {
    const tools = buildMediaSendTools(CONFIG, COORDS);
    const res = await invoke(tools, SEND_MEDIA_TOOL_NAME, { source: 'chart.png', channelId: 'ATTACKER' });
    expect(res.isError).toBeUndefined();
    const call = sendMediaToChannel.mock.calls[0][0] as Record<string, unknown>;
    expect(call.channelId).toBe('g1'); // from coords, not the injected arg
    expect(call.channelType).toBe(ChannelType.Group);
    expect(call.cwdDir).toBe('/tmp/sandbox');
    expect(call.source).toBe('chart.png');
    // Identity is always bot — no on_behalf_of / persona field is threaded through.
    expect('onBehalfOf' in call).toBe(false);
  });

  it('errs when the account is not configured', async () => {
    const tools = buildMediaSendTools({ apiUrl: '', botToken: '' }, COORDS);
    const res = await invoke(tools, SEND_MEDIA_TOOL_NAME, { source: 'chart.png' });
    expect(res.isError).toBe(true);
    expect(sendMediaToChannel).not.toHaveBeenCalled();
  });

  it('errs when the delivery channel is unavailable', async () => {
    const tools = buildMediaSendTools(CONFIG, { ...COORDS, channelId: '' });
    const res = await invoke(tools, SEND_MEDIA_TOOL_NAME, { source: 'chart.png' });
    expect(res.isError).toBe(true);
    expect(sendMediaToChannel).not.toHaveBeenCalled();
  });

  it('surfaces an orchestration error', async () => {
    sendMediaToChannel.mockRejectedValue(new Error('拒绝上传绝对路径'));
    const tools = buildMediaSendTools(CONFIG, COORDS);
    const res = await invoke(tools, SEND_MEDIA_TOOL_NAME, { source: '/etc/passwd' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('拒绝上传绝对路径');
  });
});

describe('octo_send_rich_text', () => {
  it('forwards text + images to the runtime-owned channel', async () => {
    const tools = buildMediaSendTools(CONFIG, COORDS);
    const res = await invoke(tools, SEND_RICH_TEXT_TOOL_NAME, { text: 'hi', images: ['a.png', 'b.png'] });
    expect(res.isError).toBeUndefined();
    const call = sendRichTextToChannel.mock.calls[0][0] as Record<string, unknown>;
    expect(call.channelId).toBe('g1');
    expect(call.text).toBe('hi');
    expect(call.images).toEqual(['a.png', 'b.png']);
  });

  it('errs when both text and images are empty', async () => {
    const tools = buildMediaSendTools(CONFIG, COORDS);
    const res = await invoke(tools, SEND_RICH_TEXT_TOOL_NAME, { text: '   ', images: [] });
    expect(res.isError).toBe(true);
    expect(sendRichTextToChannel).not.toHaveBeenCalled();
  });

  it('reports a total failure as a tool error', async () => {
    sendRichTextToChannel.mockResolvedValue({ messageId: '', imageCount: 0, failedMedia: [{ source: 'x', error: 'boom' }], richText: false });
    const tools = buildMediaSendTools(CONFIG, COORDS);
    const res = await invoke(tools, SEND_RICH_TEXT_TOOL_NAME, { text: '', images: ['x'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('boom');
  });
});
