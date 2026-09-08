/**
 * LOO-17: File-type message content extraction across the group-context path.
 *
 * Root cause fixed here: a File dropped in a group as a non-triggering message
 * was cached via `renderMessageForContext` → `resolveContent(payload, apiUrl)`
 * WITHOUT the media CDN host, so `buildMediaUrl` dropped the CDN-hosted download
 * URL and the file degraded to a bare `[文件: name]` marker — the agent, when
 * addressed later, saw neither the URL nor the content. The fix threads
 * `cdnHost` through and (approach C) lazily resolves recent File markers at the
 * trigger turn via the same `tryResolveFile` pipeline.
 *
 * DNS isolation: `tryResolveFile` calls `assertPublicUrl` which does a DNS
 * lookup for non-IP hosts. We mock it to map any `example.com` host to a public
 * IP (same pattern as g2-file-inline.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroupContext } from '../group-context.js';
import { createAdapter } from '../db-adapter.js';
import type { DbAdapter } from '../db-adapter.js';
import {
  resolveContent,
  parseInboundFileMarker,
  tryResolveFile,
  INLINE_FILE_MAX_BYTES,
} from '../inbound.js';
import { MessageType } from '../octo/types.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname.includes('example.com')) {
      return [{ address: '203.0.113.42', family: 4 }];
    }
    throw new Error(`Test DNS mock: unexpected hostname ${hostname}`);
  }),
}));

vi.mock('../octo/api.js', () => ({
  getGroupMembers: vi.fn().mockResolvedValue([]),
  fetchUserInfo: vi.fn().mockResolvedValue(null),
}));

const API_URL = 'https://api.example.com';
const CDN_HOST = 'cdn.example.com';
// A File download URL as Octo delivers it: absolute, on the media CDN host,
// which is a DIFFERENT host than apiUrl.
const CDN_FILE_URL = `https://${CDN_HOST}/file/abc123/testUpload.txt`;

function filewPayload(url: string, name = 'testUpload.txt') {
  return { type: MessageType.File, url, name };
}

function streamOf(content: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(content));
      c.close();
    },
  });
}

describe('LOO-17 root cause: cdnHost must be threaded into resolveContent for File', () => {
  it('drops the CDN-hosted File URL to a bare marker WITHOUT cdnHost', () => {
    const resolved = resolveContent(filewPayload(CDN_FILE_URL), API_URL /* no cdnHost */);
    expect(resolved.mediaUrl).toBeUndefined();
    expect(resolved.text).toBe('[文件: testUpload.txt]'); // no URL — the bug
  });

  it('keeps the CDN-hosted File URL WITH cdnHost', () => {
    const resolved = resolveContent(filewPayload(CDN_FILE_URL), API_URL, CDN_HOST);
    expect(resolved.mediaUrl).toBe(CDN_FILE_URL);
    expect(resolved.text).toBe(`[文件: testUpload.txt]\n${CDN_FILE_URL}`);
  });
});

describe('LOO-17: parseInboundFileMarker', () => {
  it('parses a File marker carrying a URL', () => {
    const marker = resolveContent(filewPayload(CDN_FILE_URL), API_URL, CDN_HOST).text;
    expect(parseInboundFileMarker(marker)).toEqual({
      filename: 'testUpload.txt',
      url: CDN_FILE_URL,
    });
  });

  it('returns null for a bare File marker (no URL)', () => {
    expect(parseInboundFileMarker('[文件: testUpload.txt]')).toBeNull();
  });

  it('returns null for a non-File media marker', () => {
    expect(parseInboundFileMarker(`[图片]\n${CDN_FILE_URL}`)).toBeNull();
  });

  it('returns null for plain text', () => {
    expect(parseInboundFileMarker('just a chat line')).toBeNull();
  });

  it('returns null when the second line is not an http(s) URL', () => {
    expect(parseInboundFileMarker('[文件: x.txt]\nnot-a-url')).toBeNull();
  });

  it('ignores trailing lines after the URL line', () => {
    expect(parseInboundFileMarker(`[文件: a.md]\n${CDN_FILE_URL}\ntrailing`)).toEqual({
      filename: 'a.md',
      url: CDN_FILE_URL,
    });
  });
});

describe('LOO-17: File payload → four-branch resolution via tryResolveFile', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Drive each branch the way the group-context path does: resolveContent →
  // parseInboundFileMarker → tryResolveFile.
  async function resolveFromPayload(url: string, name: string, knownSize?: number) {
    const marker = resolveContent(filewPayload(url, name), API_URL, CDN_HOST).text;
    const ref = parseInboundFileMarker(marker);
    expect(ref).not.toBeNull();
    return tryResolveFile({
      url: ref!.url,
      botToken: 'tok',
      apiUrl: API_URL,
      filename: ref!.filename,
      knownSize,
    });
  }

  it('(a) small text file → inlined content', async () => {
    const body = 'hello from testUpload\n';
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: streamOf(body) } as unknown as Response);
    const result = await resolveFromPayload(CDN_FILE_URL, 'testUpload.txt');
    expect(result).toHaveProperty('inlined');
    if ('inlined' in result) expect(result.inlined).toBe(body);
  });

  it('(b) large text file → temp path on disk', async () => {
    const big = 'A'.repeat(INLINE_FILE_MAX_BYTES + 4_096);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: streamOf(big) } as unknown as Response);
    const result = await resolveFromPayload(`https://${CDN_HOST}/file/abc/big.txt`, 'big.txt');
    expect(result).toHaveProperty('tempPath');
    if ('tempPath' in result) {
      expect(result.tempPath).toContain('/tmp/cc-channel-octo/inbound-files');
      expect(result.tempPath).toContain('big.txt');
    }
  });

  it('(c) non-text file → description (no download), URL still available from the marker', async () => {
    // Non-text ext short-circuits before any fetch — assert fetch is never called.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const result = await resolveFromPayload(`https://${CDN_HOST}/file/abc/photo.jpg`, 'photo.jpg');
    expect(result).toHaveProperty('description');
    if ('description' in result) expect(result.description).toContain('photo.jpg');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('(d) download failure → degradation text', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, body: null } as unknown as Response);
    const result = await resolveFromPayload(`https://${CDN_HOST}/file/abc/missing.md`, 'missing.md');
    expect(result).toHaveProperty('description');
    if ('description' in result) expect(result.description).toContain('HTTP 404');
  });

  it('(d) over-limit by knownSize → degradation text', async () => {
    const result = await resolveFromPayload(`https://${CDN_HOST}/file/abc/huge.md`, 'huge.md', 10 * 1024 * 1024);
    expect(result).toHaveProperty('description');
    if ('description' in result) expect(result.description).toContain('超过下载上限');
  });
});

describe('LOO-17: GroupContext.collectFileRefsSince', () => {
  let adapter: DbAdapter;
  let ctx: GroupContext;

  function createTestAdapter(): DbAdapter {
    const a = createAdapter(':memory:');
    a.exec(`
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL, uid TEXT NOT NULL, name TEXT NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY(group_id, uid)
      );
    `);
    return a;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createTestAdapter();
    ctx = new GroupContext(adapter, 6000);
  });

  function pushFile(name: string, url: string, uid = 'u1', display = 'Alice') {
    const marker = resolveContent(filewPayload(url, name), API_URL, CDN_HOST).text;
    ctx.pushMessage('ch1', uid, display, marker, 1_700_000_000);
  }

  it('extracts File refs (filename + url) from cached markers, skipping non-files', () => {
    pushFile('a.txt', `https://${CDN_HOST}/file/1/a.txt`);
    ctx.pushMessage('ch1', 'u1', 'Alice', 'a normal chat line', 1_700_000_001);
    ctx.pushMessage('ch1', 'u1', 'Alice', `[图片]\nhttps://${CDN_HOST}/file/img.png`, 1_700_000_002);
    pushFile('b.md', `https://${CDN_HOST}/file/2/b.md`);

    const refs = ctx.collectFileRefsSince('ch1', 0, 10);
    expect(refs.map((r) => r.filename)).toEqual(['a.txt', 'b.md']); // chronological
    expect(refs[0].url).toBe(`https://${CDN_HOST}/file/1/a.txt`);
    expect(refs[0].fromName).toContain('Alice');
  });

  it('caps at maxFiles, keeping the most-recent files', () => {
    pushFile('old.txt', `https://${CDN_HOST}/file/old.txt`);
    pushFile('mid.txt', `https://${CDN_HOST}/file/mid.txt`);
    pushFile('new.txt', `https://${CDN_HOST}/file/new.txt`);

    const refs = ctx.collectFileRefsSince('ch1', 0, 2);
    // newest-first selection, returned chronologically → [mid, new]
    expect(refs.map((r) => r.filename)).toEqual(['mid.txt', 'new.txt']);
  });

  it('honors the sinceId cursor (only files newer than the cursor)', () => {
    pushFile('seen.txt', `https://${CDN_HOST}/file/seen.txt`);
    const cursor = ctx.getMaxMessageId('ch1');
    pushFile('fresh.txt', `https://${CDN_HOST}/file/fresh.txt`);

    const refs = ctx.collectFileRefsSince('ch1', cursor, 10);
    expect(refs.map((r) => r.filename)).toEqual(['fresh.txt']);
  });

  it('returns nothing for a bare (URL-less) File marker', () => {
    ctx.pushMessage('ch1', 'u1', 'Alice', '[文件: bare.txt]', 1_700_000_000);
    expect(ctx.collectFileRefsSince('ch1', 0, 10)).toEqual([]);
  });

  it('returns [] when maxFiles is 0', () => {
    pushFile('a.txt', `https://${CDN_HOST}/file/a.txt`);
    expect(ctx.collectFileRefsSince('ch1', 0, 0)).toEqual([]);
  });
});
