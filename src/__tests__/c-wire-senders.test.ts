/**
 * C3 wire-layer tests: sendMediaMessage (Image/File) + sendRichTextMessage
 * (type 14). Uses the REAL octo/api.ts against a mocked global fetch.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { sendMediaMessage, sendRichTextMessage } from '../octo/api.js';
import { ChannelType, MessageType, RICH_TEXT_BLOCK_TEXT, RICH_TEXT_BLOCK_IMAGE } from '../octo/types.js';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function bodyOf(callIndex = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const BASE = { apiUrl: 'https://test.example.com', botToken: 'bf_test' };
const CHAN = { channelId: 'g1', channelType: ChannelType.Group };

describe('sendMediaMessage', () => {
  it('builds an Image(=2) payload with width/height/name/size', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ message_id: 'm1' }));
    const res = await sendMediaMessage({
      ...BASE, ...CHAN,
      type: MessageType.Image,
      url: 'https://cdn.example/x.png',
      name: 'x.png', size: 1234, width: 10, height: 20,
      clientMsgNo: 'c1',
    });
    expect(res?.message_id).toBe('m1');
    const body = bodyOf();
    const payload = body.payload as Record<string, unknown>;
    expect(payload.type).toBe(MessageType.Image);
    expect(payload.url).toBe('https://cdn.example/x.png');
    expect(payload.width).toBe(10);
    expect(payload.height).toBe(20);
    expect(payload.name).toBe('x.png');
    expect(payload.size).toBe(1234);
    expect(body.client_msg_no).toBe('c1');
  });

  it('builds a File(=8) payload without width/height', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ message_id: 'm2' }));
    await sendMediaMessage({
      ...BASE, ...CHAN,
      type: MessageType.File,
      url: 'https://cdn.example/doc.pdf',
      name: 'doc.pdf', size: 5, width: 10, height: 20,
    });
    const payload = bodyOf().payload as Record<string, unknown>;
    expect(payload.type).toBe(MessageType.File);
    expect(payload.name).toBe('doc.pdf');
    expect(payload.size).toBe(5);
    expect(payload.width).toBeUndefined();
    expect(payload.height).toBeUndefined();
  });

  it('rejects an empty channelId before any fetch', async () => {
    await expect(
      sendMediaMessage({ ...BASE, channelId: '  ', channelType: ChannelType.Group, type: MessageType.File, url: 'u' }),
    ).rejects.toThrow(/channelId is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendRichTextMessage', () => {
  it('builds a RichText(=14) content array + plain', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ message_id: 'r1' }));
    const blocks = [
      { type: RICH_TEXT_BLOCK_TEXT, text: 'hello' },
      { type: RICH_TEXT_BLOCK_IMAGE, url: 'https://cdn/x.png', width: 10, height: 20 },
    ];
    const res = await sendRichTextMessage({ ...BASE, ...CHAN, blocks, plain: 'hello[图片]', clientMsgNo: 'c2' });
    expect(res?.message_id).toBe('r1');
    const payload = bodyOf().payload as Record<string, unknown>;
    expect(payload.type).toBe(MessageType.RichText);
    expect(payload.content).toEqual(blocks);
    expect(payload.plain).toBe('hello[图片]');
  });

  it('rejects an empty blocks array before any fetch', async () => {
    await expect(sendRichTextMessage({ ...BASE, ...CHAN, blocks: [] })).rejects.toThrow(/non-empty blocks/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty channelId before any fetch', async () => {
    await expect(
      sendRichTextMessage({ ...BASE, channelId: '', channelType: ChannelType.Group, blocks: [{ type: 'text', text: 'x' }] }),
    ).rejects.toThrow(/channelId is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
