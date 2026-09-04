/**
 * C1/C3 orchestration tests: resolveMediaSource (data / http / local sandbox),
 * the streaming size cap, SSRF rejection, and the full sendMediaToChannel /
 * sendRichTextToChannel paths. The octo/api.ts wire layer is mocked so these
 * tests exercise resolution + assembly, not real HTTP.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── Mock the wire layer. generateClientMsgNo stays deterministic. ────────────
const getUploadPresign = vi.fn();
const uploadFileToPresignedUrl = vi.fn();
const sendMediaMessage = vi.fn();
const sendRichTextMessage = vi.fn();
const sendMessage = vi.fn();

vi.mock('../octo/api.js', () => ({
  getUploadPresign: (...a: unknown[]) => getUploadPresign(...a),
  uploadFileToPresignedUrl: (...a: unknown[]) => uploadFileToPresignedUrl(...a),
  sendMediaMessage: (...a: unknown[]) => sendMediaMessage(...a),
  sendRichTextMessage: (...a: unknown[]) => sendRichTextMessage(...a),
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  generateClientMsgNo: () => 'cmn-test',
}));

import {
  resolveMediaSource,
  sendMediaToChannel,
  sendRichTextToChannel,
  parseImageDimensions,
  MAX_OUTBOUND_UPLOAD_BYTES,
} from '../media-outbound.js';
import { ChannelType } from '../octo/types.js';

/** A minimal valid PNG header advertising a `w`×`h` image. */
function pngBuffer(w: number, h: number): Buffer {
  const buf = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

const BASE = { apiUrl: 'https://test.example.com', botToken: 'bf_test' };
const CHAN = { channelId: 'g1', channelType: ChannelType.Group };

let cwd: string;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  getUploadPresign.mockReset();
  uploadFileToPresignedUrl.mockReset();
  sendMediaMessage.mockReset();
  sendRichTextMessage.mockReset();
  sendMessage.mockReset();
  getUploadPresign.mockResolvedValue({
    uploadUrl: 'https://storage.example/put?sig=1',
    downloadUrl: 'https://cdn.example/dl/obj',
    contentType: 'image/png',
  });
  uploadFileToPresignedUrl.mockResolvedValue({ url: 'https://cdn.example/dl/obj' });
  sendMediaMessage.mockResolvedValue({ message_id: 'm1' });
  sendRichTextMessage.mockResolvedValue({ message_id: 'r1' });
  sendMessage.mockResolvedValue({ message_id: 't1' });
  cwd = await mkdtemp(path.join(tmpdir(), 'cc-out-media-'));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(cwd, { recursive: true, force: true });
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('resolveMediaSource — data: URIs', () => {
  it('rejects an oversize data URI without allocating (size cap)', async () => {
    // ~40 base64 chars ≈ 30 bytes decoded, cap = 8.
    const b64 = Buffer.alloc(30).toString('base64');
    await expect(
      resolveMediaSource({ source: `data:image/png;base64,${b64}`, cwdDir: cwd, ...BASE, maxBytes: 8 }),
    ).rejects.toThrow(/大小上限/);
  });

  it('resolves a small data URI to a buffer + content type', async () => {
    const png = pngBuffer(10, 20);
    const r = await resolveMediaSource({
      source: `data:image/png;base64,${png.toString('base64')}`,
      cwdDir: cwd, ...BASE,
    });
    expect(r.contentType).toBe('image/png');
    expect(r.fileBuffer?.length).toBe(png.length);
    expect(r.fileSize).toBe(png.length);
  });
});

describe('resolveMediaSource — SSRF + path confinement', () => {
  it('rejects an http source resolving to a private/loopback address', async () => {
    await expect(
      resolveMediaSource({ source: 'http://127.0.0.1/secret.png', cwdDir: cwd, ...BASE }),
    ).rejects.toThrow(/private|local/i);
  });

  it('rejects an absolute local path (sandbox escape)', async () => {
    await expect(
      resolveMediaSource({ source: '/etc/passwd', cwdDir: cwd, ...BASE }),
    ).rejects.toThrow(/绝对路径|file:\/\//);
  });

  it('rejects a file:// URL', async () => {
    await expect(
      resolveMediaSource({ source: 'file:///etc/passwd', cwdDir: cwd, ...BASE }),
    ).rejects.toThrow(/绝对路径|file:\/\//);
  });

  it('rejects a relative path escaping the cwd sandbox', async () => {
    // Create a file OUTSIDE cwd and try to reach it via ../
    const outside = await mkdtemp(path.join(tmpdir(), 'cc-out-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'x');
      const rel = path.relative(cwd, path.join(outside, 'secret.txt'));
      await expect(
        resolveMediaSource({ source: rel, cwdDir: cwd, ...BASE }),
      ).rejects.toThrow(/工作目录之外|不存在/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('resolves a valid file inside the cwd sandbox', async () => {
    await mkdir(path.join(cwd, 'out'), { recursive: true });
    await writeFile(path.join(cwd, 'out', 'chart.png'), pngBuffer(5, 6));
    const r = await resolveMediaSource({ source: 'out/chart.png', cwdDir: cwd, ...BASE });
    expect(r.contentType).toBe('image/png');
    expect(r.filename).toBe('chart.png');
    expect(r.bodyPath).toBeTruthy();
    expect(r.fileSize).toBeGreaterThan(0);
  });

  it('rejects an empty local file', async () => {
    await writeFile(path.join(cwd, 'empty.txt'), '');
    await expect(
      resolveMediaSource({ source: 'empty.txt', cwdDir: cwd, ...BASE }),
    ).rejects.toThrow(/为空/);
  });
});

describe('resolveMediaSource — http streaming size cap', () => {
  it('aborts + throws when the streamed body exceeds the cap', async () => {
    // Public IP literal → assertPublicUrl passes without DNS; body is 20 bytes, cap 10.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(new Uint8Array(20)); c.close(); },
        }),
        { status: 200, headers: { 'content-type': 'image/png' } },
      ),
    ) as unknown as typeof fetch;
    await expect(
      resolveMediaSource({ source: 'http://93.184.216.34/big.png', cwdDir: cwd, ...BASE, maxBytes: 10 }),
    ).rejects.toThrow(/大小上限/);
  });
});

describe('sendMediaToChannel', () => {
  it('uploads via presign and sends an Image message with parsed dims', async () => {
    await writeFile(path.join(cwd, 'chart.png'), pngBuffer(10, 20));
    const res = await sendMediaToChannel({ source: 'chart.png', cwdDir: cwd, ...BASE, ...CHAN });
    expect(getUploadPresign).toHaveBeenCalledOnce();
    expect(uploadFileToPresignedUrl).toHaveBeenCalledOnce();
    expect(sendMediaMessage).toHaveBeenCalledOnce();
    const call = sendMediaMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(call.channelId).toBe('g1');
    expect(call.type).toBe(2); // MessageType.Image
    expect(call.width).toBe(10);
    expect(call.height).toBe(20);
    expect(res.type).toBe('image');
    expect(res.messageId).toBe('m1');
  });

  it('sends a non-image as a File message', async () => {
    getUploadPresign.mockResolvedValue({
      uploadUrl: 'https://storage.example/put', downloadUrl: 'https://cdn.example/dl/doc',
      contentType: 'application/pdf',
    });
    await writeFile(path.join(cwd, 'doc.pdf'), Buffer.alloc(16, 1));
    const res = await sendMediaToChannel({ source: 'doc.pdf', cwdDir: cwd, ...BASE, ...CHAN });
    const call = sendMediaMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(call.type).toBe(8); // MessageType.File
    expect(res.type).toBe('file');
  });
});

describe('sendRichTextToChannel', () => {
  it('assembles a RichText payload = [text block, image block]', async () => {
    await writeFile(path.join(cwd, 'a.png'), pngBuffer(30, 40));
    const res = await sendRichTextToChannel({
      text: 'look at this', images: ['a.png'], cwdDir: cwd, ...BASE, ...CHAN,
    });
    expect(sendRichTextMessage).toHaveBeenCalledOnce();
    const call = sendRichTextMessage.mock.calls[0][0] as Record<string, unknown>;
    const blocks = call.blocks as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'look at this' });
    expect(blocks[1]).toMatchObject({ type: 'image', width: 30, height: 40 });
    expect(res.richText).toBe(true);
    expect(res.imageCount).toBe(1);
  });

  it('degrades to text + sideload when no dimensioned image survives', async () => {
    getUploadPresign.mockResolvedValue({
      uploadUrl: 'https://storage.example/put', downloadUrl: 'https://cdn.example/dl/doc',
      contentType: 'application/pdf',
    });
    await writeFile(path.join(cwd, 'notes.pdf'), Buffer.alloc(8, 2));
    const res = await sendRichTextToChannel({
      text: 'a file', images: ['notes.pdf'], cwdDir: cwd, ...BASE, ...CHAN,
    });
    expect(sendRichTextMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce(); // the text
    expect(sendMediaMessage).toHaveBeenCalledOnce(); // the sideloaded file
    expect(res.richText).toBe(false);
    expect(res.imageCount).toBe(1);
  });

  it('records a failed source instead of throwing', async () => {
    const res = await sendRichTextToChannel({
      text: 'hi', images: ['/etc/shadow'], cwdDir: cwd, ...BASE, ...CHAN,
    });
    // /etc/shadow is an absolute path → rejected during resolve, recorded as failed.
    expect(res.failedMedia).toHaveLength(1);
    // text still delivered (no image survived → degraded text send)
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(res.richText).toBe(false);
  });
});

describe('parseImageDimensions', () => {
  it('reads PNG dimensions', () => {
    expect(parseImageDimensions(pngBuffer(123, 456), 'image/png')).toEqual({ width: 123, height: 456 });
  });
  it('exposes a sane default cap', () => {
    expect(MAX_OUTBOUND_UPLOAD_BYTES).toBeGreaterThan(0);
  });
});
