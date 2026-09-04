/**
 * C1/C3 orchestration tests: resolveMediaSource (data / http / local sandbox),
 * the streaming size cap, SSRF rejection, and the full sendMediaToChannel /
 * sendRichTextToChannel paths. The octo/api.ts wire layer is mocked so these
 * tests exercise resolution + assembly, not real HTTP.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, stat, readdir, symlink, unlink, utimes, open } from 'node:fs/promises';
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
  disposeResolvedMedia,
  sendMediaToChannel,
  sendRichTextToChannel,
  parseImageDimensions,
  cleanupStaleUploadTempFiles,
  MAX_OUTBOUND_UPLOAD_BYTES,
} from '../media-outbound.js';
import { ChannelType } from '../octo/types.js';

const UPLOAD_TEMP_DIR = path.join(tmpdir(), 'cc-octo-upload');

/** Consume a Web/Node stream (or buffer) into a Buffer. */
async function drain(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

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
    expect(r.fileHandle).toBeTruthy();
    expect(r.fileSize).toBeGreaterThan(0);
    await disposeResolvedMedia(r);
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

// ─── R1 #1: outbound HTTP fetch must NOT carry the bot token ──────────────────
describe('resolveMediaSource — outbound fetch is unauthenticated (R1 #1)', () => {
  it('does not attach Authorization to a same-origin non-media API URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    // apiUrl host == source host (same origin), and the path is a Bot API, not media.
    const r = await resolveMediaSource({
      source: 'http://93.184.216.34/v1/bot/upload/credentials',
      cwdDir: cwd,
      apiUrl: 'https://93.184.216.34',
      botToken: 'bf_secret',
    });
    await disposeResolvedMedia(r);
    expect(fetchSpy).toHaveBeenCalled();
    // No hop may carry an Authorization header, and the token must not appear anywhere.
    for (const call of fetchSpy.mock.calls) {
      const init = (call[1] ?? {}) as RequestInit;
      const headers = new Headers(init.headers as HeadersInit | undefined);
      expect(headers.has('authorization')).toBe(false);
      expect(JSON.stringify(init.headers ?? {})).not.toContain('bf_secret');
    }
  });
});

// ─── R1 #2: cwd realpath TOCTOU — fd is pinned at validation ──────────────────
describe('resolveMediaSource — TOCTOU-safe fd pinning (R1 #2)', () => {
  it('rejects a symlink inside cwd that points outside the sandbox', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'cc-out-jail-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET');
      await symlink(path.join(outside, 'secret.txt'), path.join(cwd, 'link.txt'));
      await expect(
        resolveMediaSource({ source: 'link.txt', cwdDir: cwd, ...BASE }),
      ).rejects.toThrow(/工作目录之外/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('streams the ORIGINAL inode even if the path is swapped to an outside symlink after validation', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'cc-out-swap-'));
    try {
      const original = Buffer.from('ORIGINAL-INSIDE-CONTENT!!');
      const swapped = Buffer.alloc(original.length, 0x58); // same size, different bytes
      await writeFile(path.join(outside, 'evil.bin'), swapped);
      await writeFile(path.join(cwd, 'file.bin'), original);

      // Validation opens + pins the fd.
      const r = await resolveMediaSource({ source: 'file.bin', cwdDir: cwd, ...BASE });
      try {
        // Attacker swaps the path to a symlink pointing OUTSIDE, same size.
        await unlink(path.join(cwd, 'file.bin'));
        await symlink(path.join(outside, 'evil.bin'), path.join(cwd, 'file.bin'));

        // The upload streams from the pinned fd → original bytes, NOT the swap.
        const streamed = await drain(r.fileHandle!.createReadStream({ start: 0, autoClose: false }));
        expect(streamed.equals(original)).toBe(true);
      } finally {
        await disposeResolvedMedia(r);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// ─── R1 #3: private temp dir/file perms + stale cleanup ───────────────────────
describe('temp file/dir hardening (R1 #3)', () => {
  function httpResp(bytes: number): Response {
    return new Response(
      new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }),
      { status: 200, headers: { 'content-type': 'application/pdf' } },
    );
  }

  it('creates the temp dir 0700 and the temp file 0600', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(httpResp(32)) as unknown as typeof fetch;
    const r = await resolveMediaSource({ source: 'http://93.184.216.34/f.pdf', cwdDir: cwd, ...BASE });
    try {
      const dirMode = (await stat(UPLOAD_TEMP_DIR)).mode & 0o777;
      const fileMode = (await stat(r.tempPath!)).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    } finally {
      await disposeResolvedMedia(r);
    }
  });

  it('sweeps stale leftover temp files (crashed prior run)', async () => {
    await mkdir(UPLOAD_TEMP_DIR, { recursive: true });
    const staleFh = await open(path.join(UPLOAD_TEMP_DIR, 'stale-leftover.bin'), 'w');
    await staleFh.close();
    const fresh = path.join(UPLOAD_TEMP_DIR, 'fresh-keepme.bin');
    const freshFh = await open(fresh, 'w');
    await freshFh.close();
    // Backdate the stale file 2h.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(UPLOAD_TEMP_DIR, 'stale-leftover.bin'), twoHoursAgo, twoHoursAgo);

    await cleanupStaleUploadTempFiles();
    const remaining = await readdir(UPLOAD_TEMP_DIR);
    expect(remaining).not.toContain('stale-leftover.bin');
    expect(remaining).toContain('fresh-keepme.bin');
    await unlink(fresh).catch(() => {});
  });

  it('leaves no temp file behind when the upload fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(httpResp(16)) as unknown as typeof fetch;
    getUploadPresign.mockResolvedValue({
      uploadUrl: 'https://storage.example/put', downloadUrl: 'https://cdn.example/dl', contentType: 'application/pdf',
    });
    uploadFileToPresignedUrl.mockRejectedValue(new Error('boom upload'));
    await expect(
      sendMediaToChannel({ source: 'http://93.184.216.34/f.pdf', cwdDir: cwd, ...BASE, ...CHAN }),
    ).rejects.toThrow(/boom upload/);
    // The temp file created for this send must be gone (finally → dispose).
    const remaining = (await readdir(UPLOAD_TEMP_DIR).catch(() => [])).filter((f) => f.endsWith('-f.pdf'));
    expect(remaining).toHaveLength(0);
  });
});

// ─── R1 #4: data URI base64 vs percent-encoding (RFC 2397) ────────────────────
describe('resolveMediaSource — data URI decoding (R1 #4)', () => {
  it('base64-decodes only when the ;base64 marker is present', async () => {
    const r = await resolveMediaSource({ source: 'data:text/plain;base64,aGVsbG8=', cwdDir: cwd, ...BASE });
    expect(r.fileBuffer?.toString('utf-8')).toBe('hello');
    expect(r.contentType).toBe('text/plain');
    await disposeResolvedMedia(r);
  });

  it('percent-decodes a non-base64 data URI (no longer garbles it)', async () => {
    const r = await resolveMediaSource({ source: 'data:text/plain,hello%20world', cwdDir: cwd, ...BASE });
    expect(r.fileBuffer?.toString('utf-8')).toBe('hello world');
    expect(r.contentType).toBe('text/plain');
    await disposeResolvedMedia(r);
  });

  it('defaults to text/plain when the mediatype is omitted', async () => {
    const r = await resolveMediaSource({ source: 'data:,abc', cwdDir: cwd, ...BASE });
    expect(r.fileBuffer?.toString('utf-8')).toBe('abc');
    expect(r.contentType).toBe('text/plain');
    await disposeResolvedMedia(r);
  });

  it('rejects malformed percent-encoding', async () => {
    await expect(
      resolveMediaSource({ source: 'data:text/plain,bad%ZZ', cwdDir: cwd, ...BASE }),
    ).rejects.toThrow(/百分号编码非法/);
  });
});

