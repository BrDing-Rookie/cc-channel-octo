/**
 * C1 / C2 / C3 — outbound rich-media send path.
 *
 * cc's StreamRelay only sends TEXT. This module adds the "send an image / file /
 * mixed text+image" path the agent needs, built on the backend-agnostic
 * presigned upload (C3, `getUploadPresign` / `uploadFileToPresignedUrl` in
 * octo/api.ts — MinIO / COS / S3 / OSS). The tool surface that drives it lives
 * in media-send-tool.ts; this module is the pure-ish orchestration.
 *
 * A single send is three steps:
 *   1. resolve the media source → an open byte body + size + contentType + name
 *      (`resolveMediaSource`),
 *   2. upload it via a server-issued presigned PUT → a serveable downloadUrl
 *      (`uploadResolvedMedia`),
 *   3. POST the message (`sendMediaMessage` type Image/File, or
 *      `sendRichTextMessage` type 14 for mixed text+image).
 *
 * ── Security (hard acceptance items + review round 1 fixes) ──────────────────
 *   • **Size cap** — every source is bounded by `MAX_OUTBOUND_UPLOAD_BYTES`
 *     BEFORE the presigned PUT (a base64 `data:` URI is measured from its base64
 *     length without allocating; an HTTP body is capped WHILE streaming; a local
 *     file is fstat-checked on the open fd). Enforced pre-upload so we never sign
 *     an upload on an oversize object.
 *   • **Stream to a private temp file** — an HTTP media source is streamed to a
 *     temp file (dir 0700, file 0600, O_EXCL — not umask-dependent) with
 *     backpressure + a hard byte cap, then streamed into the PUT from an open fd
 *     and unlinked in `finally`. Stale temp files (crashed prior runs) are swept
 *     opportunistically.
 *   • **SSRF on HTTP media sources** — reuses the inbound defense verbatim
 *     (`assertPublicUrl` + `fetchWithRedirectGuard` from url-policy.ts). NOTE:
 *     unlike the inbound path, the outbound fetch attaches **no Authorization**
 *     — the source URL is model-controlled, so replaying the bot token to a
 *     same-origin Bot API endpoint would let a prompt-injected agent read + exfil
 *     API responses (review R1 #1). Outbound media fetch is unauthenticated.
 *   • **Local paths are sandbox-confined, TOCTOU-safe** — a local source must be
 *     a path inside the session cwd sandbox. We open the fd FIRST, verify the
 *     OPENED inode's real path stays within `cwdDir`, fstat that fd, and stream
 *     the upload from the SAME fd — never re-opening by path across the async
 *     presign boundary, so a symlink swap after validation cannot redirect the
 *     bytes (review R1 #2). Absolute paths / `file://` are rejected outright.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, unlink, realpath, chmod, open, readlink, readdir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { assertPublicUrl, fetchWithRedirectGuard } from './url-policy.js';
import {
  getUploadPresign,
  uploadFileToPresignedUrl,
  sendMediaMessage,
  sendRichTextMessage,
  sendMessage,
  generateClientMsgNo,
} from './octo/api.js';
import {
  ChannelType,
  MessageType,
  RICH_TEXT_BLOCK_TEXT,
  RICH_TEXT_BLOCK_IMAGE,
  RICH_TEXT_IMAGE_PLACEHOLDER,
  type RichTextBlock,
} from './octo/types.js';

/**
 * Hard per-upload byte cap. Matches the openclaw outbound cap (files can be
 * large); the point of the cap is to bound memory / bandwidth / storage, not to
 * second-guess the operator. Callers may pass a smaller `maxBytes`.
 */
export const MAX_OUTBOUND_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Private temp dir for HTTP media streamed to disk before upload (0700). */
const UPLOAD_TEMP_DIR = path.join(os.tmpdir(), 'cc-octo-upload');

/** Mode for the private temp dir — owner-only (rwx). Not umask-dependent. */
const TEMP_DIR_MODE = 0o700;
/** Mode for temp media files — owner read/write only. Not umask-dependent. */
const TEMP_FILE_MODE = 0o600;

/** Default timeout for streaming a remote media source to disk. */
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** Age past which a leftover temp file is considered stale (crashed run). */
const STALE_TEMP_AGE_MS = 60 * 60 * 1000; // 1h

/** Header window read for image-dimension parsing. */
const IMAGE_HEADER_SIZE = 65536;

/**
 * Strip any path separators / traversal from a caller-influenced filename so it
 * is safe to embed in a temp filename. Defense in depth — the value only ever
 * names a file under UPLOAD_TEMP_DIR, but we never want a `../` in it.
 */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  const cleaned = base.replace(/[/\0]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned.slice(0, 255);
}

/** Infer a MIME type from a filename extension; octet-stream when unknown. */
export function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp', '.ico': 'image/x-icon',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
    '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html',
    '.css': 'text/css', '.xml': 'text/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
    '.json': 'application/json',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Append `; charset=utf-8` to a bare text/* content type. */
export function ensureTextCharset(contentType: string): string {
  if (contentType.startsWith('text/') && !contentType.includes('charset')) {
    return contentType + '; charset=utf-8';
  }
  return contentType;
}

/**
 * Parse image dimensions from a header buffer (PNG / JPEG / GIF / WebP).
 * Reads only header bytes, no dependency. Returns null on unknown/corrupt.
 */
export function parseImageDimensions(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && buf.length > 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if ((mime === 'image/jpeg' || mime === 'image/jpg') && buf.length > 2) {
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] !== 0xff) break;
        const marker = buf[offset + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
        }
        const len = buf.readUInt16BE(offset + 2);
        offset += 2 + len;
      }
    }
    if (mime === 'image/gif' && buf.length > 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/webp' && buf.length > 30) {
      if (buf.toString('ascii', 12, 16) === 'VP8 ' && buf.length > 29) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
    }
  } catch { /* ignore parse errors */ }
  return null;
}

/**
 * Parse image dimensions from an OPEN file handle by reading only the first
 * 64KB via a positional read (pread at offset 0 — does not disturb the fd
 * offset, so the upload read-stream can still start at 0). Race-safe: reads
 * from the same validated fd, never re-opening by path.
 */
async function parseImageDimensionsFromHandle(
  fh: FileHandle,
  mime: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const buf = Buffer.alloc(IMAGE_HEADER_SIZE);
    const { bytesRead } = await fh.read(buf, 0, IMAGE_HEADER_SIZE, 0);
    return parseImageDimensions(buf.subarray(0, bytesRead), mime);
  } catch { /* ignore read/parse errors */ }
  return null;
}

/** Ensure the private temp dir exists with owner-only perms (not umask-based). */
async function ensureUploadTempDir(): Promise<string> {
  await mkdir(UPLOAD_TEMP_DIR, { recursive: true, mode: TEMP_DIR_MODE });
  // mkdir mode is masked by umask and skipped if the dir already existed; force
  // the mode explicitly so a lax umask or a pre-existing dir can't widen it.
  await chmod(UPLOAD_TEMP_DIR, TEMP_DIR_MODE).catch(() => {});
  return UPLOAD_TEMP_DIR;
}

/**
 * Opportunistically remove temp files left by a crashed prior run (older than
 * STALE_TEMP_AGE_MS). Best-effort; never throws.
 */
export async function cleanupStaleUploadTempFiles(now: number = Date.now()): Promise<void> {
  try {
    const files = await readdir(UPLOAD_TEMP_DIR);
    for (const f of files) {
      const fp = path.join(UPLOAD_TEMP_DIR, f);
      const st = await stat(fp).catch(() => null);
      if (st && st.isFile() && now - st.mtimeMs > STALE_TEMP_AGE_MS) {
        await unlink(fp).catch(() => {});
      }
    }
  } catch { /* dir may not exist yet */ }
}

/**
 * Stream a Web ReadableStream to a fresh temp file with a strict byte cap +
 * backpressure. The file is created O_EXCL with mode 0600 (an attacker cannot
 * pre-plant a symlink at the random path, and the bytes are never group/world
 * readable). Mirrors the inbound download loop (media-inbound.ts): the first
 * chunk past `maxBytes` cancels the reader, destroys the stream, unlinks the
 * partial file, and throws.
 */
async function streamToTempFileWithCap(opts: {
  body: ReadableStream<Uint8Array>;
  destPath: string;
  maxBytes: number;
}): Promise<void> {
  const { body, destPath, maxBytes } = opts;
  // 'wx' = O_CREAT | O_EXCL — fail if the path already exists (defeats a planted
  // symlink); mode 0600 owner-only (chmod below defeats umask on top of it).
  const ws = createWriteStream(destPath, { flags: 'wx', mode: TEMP_FILE_MODE });
  let totalBytes = 0;

  const streamError = new Promise<never>((_, reject) => {
    ws.on('error', reject);
  });
  streamError.catch(() => {});

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // Wait for the fd (race the 'open' against an early 'error', e.g. O_EXCL
    // collision), then force 0600 regardless of umask.
    await Promise.race([
      new Promise<void>((resolve) => ws.once('open', () => resolve())),
      streamError,
    ]);
    await chmod(destPath, TEMP_FILE_MODE).catch(() => {});

    reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel().catch(() => {});
        throw new Error(`媒体超过大小上限 ${maxBytes} 字节`);
      }
      if (!ws.write(value)) {
        await Promise.race([
          new Promise<void>((r) => ws.once('drain', r)),
          streamError,
        ]);
      }
    }
    ws.end();
    await Promise.race([
      new Promise<void>((resolve) => ws.on('finish', resolve)),
      streamError,
    ]);
  } catch (err) {
    reader?.cancel().catch(() => {});
    ws.destroy();
    await unlink(destPath).catch(() => {});
    throw err;
  }
}

/**
 * A media source resolved to bytes, ready to upload.
 *
 * Exactly one body carrier is set:
 *   - `fileBuffer` — a small in-memory body (data: URIs), OR
 *   - `fileHandle` — an OPEN, validated fd (local sandbox file OR downloaded
 *     temp file). The upload streams from this fd; it is never re-opened by
 *     path. The caller MUST `close()` it (and unlink `tempPath` if set).
 */
export interface ResolvedMedia {
  fileBuffer?: Buffer;
  fileHandle?: FileHandle;
  fileSize: number;
  contentType: string;
  filename: string;
  /** A temp file WE created that the caller must unlink after closing the fd. */
  tempPath?: string;
}

/** Release a resolved source's held resources (fd + temp file). Never throws. */
export async function disposeResolvedMedia(r: ResolvedMedia | undefined): Promise<void> {
  if (!r) return;
  await r.fileHandle?.close().catch(() => {});
  if (r.tempPath) await unlink(r.tempPath).catch(() => {});
}

/** Extension guess for a data: URI content type when no filename is supplied. */
const DATA_URI_EXT: Record<string, string> = {
  'text/markdown': '.md', 'text/plain': '.txt', 'application/pdf': '.pdf',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'application/json': '.json', 'application/zip': '.zip',
  'audio/mpeg': '.mp3', 'video/mp4': '.mp4',
};

/**
 * Byte-level percent-decode a `data:` URI body per RFC 2397/3986.
 *
 * `%HH` → the raw byte 0xHH (NOT a UTF-8 code point); any other run of
 * characters is emitted as its UTF-8 bytes. This is deliberately NOT
 * `decodeURIComponent`, which is character-level and throws on octet sequences
 * that aren't valid UTF-8 — so a legitimate non-UTF-8 body like
 * `data:text/plain;charset=iso-8859-7,%be` or `data:application/octet-stream,%FF`
 * would be wrongly rejected (review R1 #4 follow-up). A backend-agnostic media
 * path must be byte-exact. Throws only on a genuinely malformed `%` escape.
 */
function percentDecodeToBytes(s: string): Buffer {
  const chunks: Buffer[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '%') {
      const hex = s.slice(i + 1, i + 3);
      if (hex.length !== 2 || !/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new Error('data URI 百分号编码非法');
      }
      chunks.push(Buffer.from([parseInt(hex, 16)]));
      i += 3;
    } else {
      // Accumulate the literal run up to the next '%' and emit it as UTF-8.
      let j = i;
      while (j < s.length && s[j] !== '%') j++;
      chunks.push(Buffer.from(s.slice(i, j), 'utf-8'));
      i = j;
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Decode the body of a `data:` URI per RFC 2397.
 *
 * `data:[<mediatype>][;base64],<data>` — only the `;base64` form is base64; the
 * default form is percent-encoded BYTES (decoded byte-exact, see
 * {@link percentDecodeToBytes}; previously this silently base64-decoded BOTH,
 * turning `data:text/plain,hello%20world` into garbage — review R1 #4).
 */
function decodeDataUri(src: string, maxBytes: number, filenameHint?: string): ResolvedMedia {
  const comma = src.indexOf(',');
  if (comma < 0) throw new Error('data URI 格式非法');
  const header = src.slice('data:'.length, comma); // between "data:" and ","
  const data = src.slice(comma + 1);

  const isBase64 = /;base64$/i.test(header);
  const mediatype = (isBase64 ? header.replace(/;base64$/i, '') : header).trim();
  // First segment is the MIME; drop any parameters (e.g. ";charset=utf-8").
  // RFC default when omitted is text/plain.
  const contentType = (mediatype.split(';')[0] || 'text/plain').toLowerCase() || 'text/plain';

  let buf: Buffer;
  if (isBase64) {
    const trimmed = data.replace(/\s/g, '');
    const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
    const decodedSize = Math.floor((trimmed.length * 3) / 4) - padding;
    if (decodedSize > maxBytes) {
      throw new Error(`媒体超过大小上限 ${maxBytes} 字节 (约 ${decodedSize} 字节)`);
    }
    buf = Buffer.from(trimmed, 'base64');
  } else {
    // Percent-encoded bytes (RFC 2397). The decoded length is bounded by the
    // source length we already hold (no amplification), so decode then check.
    buf = percentDecodeToBytes(data);
  }
  if (buf.length > maxBytes) {
    throw new Error(`媒体超过大小上限 ${maxBytes} 字节 (${buf.length} 字节)`);
  }
  const ext = DATA_URI_EXT[contentType] ?? '.bin';
  const filename = filenameHint ? sanitizeFilename(filenameHint) : `file${ext}`;
  return { fileBuffer: buf, fileSize: buf.length, contentType, filename };
}

/**
 * Resolve the real path of an OPEN fd (Linux: /proc/self/fd). This reflects the
 * inode actually opened, so a later path swap cannot change it. Falls back to
 * realpath(originalPath) on platforms without /proc (best-effort).
 */
async function realPathOfFd(fh: FileHandle, fallbackPath: string): Promise<string> {
  try {
    return await readlink(`/proc/self/fd/${fh.fd}`);
  } catch {
    return await realpath(fallbackPath).catch(() => fallbackPath);
  }
}

/**
 * Resolve a media `source` into an open, validated body ready for a presigned
 * upload.
 *
 * `source` is one of:
 *   - `data:[<mime>][;base64],<data>` — inline; base64 or percent-decoded.
 *   - `http(s)://…`                   — SSRF-guarded, UNAUTHENTICATED stream to
 *                                       a private temp file.
 *   - a path RELATIVE to `cwdDir`     — local file inside the session sandbox,
 *                                       opened + confinement-checked on the fd.
 *
 * Absolute paths and `file://` URLs are rejected: the untrusted-driven agent
 * must not be able to read arbitrary host files into a group message.
 *
 * On success the returned {@link ResolvedMedia} may hold an OPEN fd and/or a
 * temp file — the caller MUST pass it to {@link disposeResolvedMedia} when done.
 */
export async function resolveMediaSource(params: {
  source: string;
  cwdDir: string;
  apiUrl: string;
  botToken: string;
  filenameHint?: string;
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<ResolvedMedia> {
  const { source, cwdDir, filenameHint } = params;
  const maxBytes = params.maxBytes ?? MAX_OUTBOUND_UPLOAD_BYTES;
  const src = source.trim();
  if (!src) throw new Error('媒体来源为空');

  // ── data: URI ──────────────────────────────────────────────────────────
  if (src.startsWith('data:')) {
    return decodeDataUri(src, maxBytes, filenameHint);
  }

  // ── http(s) URL — SSRF-guarded, UNAUTHENTICATED stream to temp file ──────
  if (/^https?:\/\//i.test(src)) {
    // Fail fast before any network I/O for the obvious private/loopback cases;
    // fetchWithRedirectGuard re-validates every hop.
    await assertPublicUrl(src);

    const urlPath = new URL(src).pathname;
    const rawName = path.basename(urlPath) || 'file';
    let filename: string;
    try { filename = decodeURIComponent(rawName); } catch { filename = rawName; }
    filename = sanitizeFilename(filenameHint ?? filename);

    const signal = params.signal ?? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    // R1 #1: the source URL is MODEL-CONTROLLED. Unlike the inbound path we do
    // NOT attach the bot token — replaying it to a same-origin Bot API endpoint
    // (e.g. /v1/bot/upload/credentials) would let a prompt-injected agent read
    // the response (temp secrets) and exfil it into the channel. Outbound media
    // fetch is unauthenticated; SSRF re-validation on every hop still applies.
    const resp = await fetchWithRedirectGuard(src, () => ({ signal }));
    if (!resp.ok) throw new Error(`下载媒体失败 HTTP ${resp.status}`);
    if (!resp.body) throw new Error('媒体响应无内容');

    let contentType = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!contentType || contentType === 'application/octet-stream') {
      contentType = inferContentType(filename);
    }

    await ensureUploadTempDir();
    // Sweep stale temp files from crashed prior runs (best-effort, fire-and-forget).
    void cleanupStaleUploadTempFiles();
    const tempPath = path.join(UPLOAD_TEMP_DIR, `${randomUUID()}-${filename}`);
    await streamToTempFileWithCap({
      body: resp.body as ReadableStream<Uint8Array>,
      destPath: tempPath,
      maxBytes,
    });

    // Open a READ fd on the just-written temp file (before any later async
    // boundary) and fstat IT — the upload streams from this fd, never re-opening.
    let fh: FileHandle;
    try {
      fh = await open(tempPath, 'r');
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw err;
    }
    const st = await fh.stat();
    if (st.size === 0) {
      await fh.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
      throw new Error('媒体为空');
    }
    return { fileHandle: fh, tempPath, fileSize: st.size, contentType, filename };
  }

  // ── explicit rejection of absolute paths / file:// (sandbox escape) ───────
  if (src.startsWith('file://') || path.isAbsolute(src)) {
    throw new Error(
      '拒绝上传绝对路径 / file:// URL：本地文件必须是会话工作目录内的相对路径',
    );
  }

  // ── local file, relative to the session cwd sandbox (TOCTOU-safe) ─────────
  const resolvedPath = path.resolve(cwdDir, src);
  let realCwd: string;
  try {
    realCwd = await realpath(cwdDir);
  } catch {
    realCwd = path.resolve(cwdDir);
  }

  // Open the fd FIRST, then validate the OPENED inode's real path. A symlink
  // swap of `resolvedPath` after this open cannot change what the fd points to,
  // and we stream the upload from this very fd (R1 #2).
  let fh: FileHandle;
  try {
    fh = await open(resolvedPath, 'r');
  } catch {
    throw new Error(`本地文件不存在或不可读: ${src}`);
  }
  try {
    const openedReal = await realPathOfFd(fh, resolvedPath);
    const rel = path.relative(realCwd, openedReal);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      // rel === '' would mean the cwd dir itself; not a file to send.
      throw new Error('拒绝上传会话工作目录之外的文件');
    }
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`不是常规文件: ${src}`);
    if (st.size > maxBytes) {
      throw new Error(`媒体超过大小上限 ${maxBytes} 字节 (${st.size} 字节)`);
    }
    if (st.size === 0) throw new Error('媒体为空');
    const filename = sanitizeFilename(filenameHint ?? path.basename(openedReal));
    return { fileHandle: fh, fileSize: st.size, contentType: inferContentType(filename), filename };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

/** An uploaded media asset — its serveable URL plus display metadata. */
export interface UploadedMedia {
  url: string;
  filename: string;
  contentType: string;
  size: number;
  isImage: boolean;
  width?: number;
  height?: number;
}

/**
 * Upload an already-resolved media body via a server-issued presigned PUT (C3)
 * and return its serveable download URL + display metadata.
 *
 * The body comes from the resolved source's in-memory buffer OR its already-open
 * fd — we NEVER re-open by path here (the fd was opened + validated in
 * `resolveMediaSource`, so the presign await between cannot be raced, R1 #2).
 */
export async function uploadResolvedMedia(params: {
  resolved: ResolvedMedia;
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<UploadedMedia> {
  const { resolved, apiUrl, botToken, signal } = params;
  const contentType = resolved.contentType || 'application/octet-stream';
  const isImage = contentType.startsWith('image/');

  // Parse dimensions BEFORE building the upload stream (positional read at 0 for
  // the fd form; direct for the buffer form) so we can start the upload at 0.
  let width: number | undefined;
  let height: number | undefined;
  if (isImage) {
    const dims = resolved.fileBuffer
      ? parseImageDimensions(resolved.fileBuffer, contentType)
      : resolved.fileHandle
        ? await parseImageDimensionsFromHandle(resolved.fileHandle, contentType)
        : null;
    width = dims?.width;
    height = dims?.height;
  }

  const presign = await getUploadPresign({
    apiUrl,
    botToken,
    filename: resolved.filename,
    fileSize: resolved.fileSize,
    contentType: ensureTextCharset(contentType),
    signal,
  });

  // Body: buffer (data URI) or a read stream on the SAME validated fd (start:0).
  const fileBody: Buffer | NodeJS.ReadableStream =
    resolved.fileBuffer ?? resolved.fileHandle!.createReadStream({ start: 0, autoClose: false });
  const { url } = await uploadFileToPresignedUrl({
    uploadUrl: presign.uploadUrl,
    downloadUrl: presign.downloadUrl,
    fileBody,
    fileSize: resolved.fileSize,
    // Replay the server-signed contentType / contentDisposition verbatim (both
    // folded into SigV4 canonical headers — 403 SignatureDoesNotMatch otherwise).
    contentType: presign.contentType,
    contentDisposition: presign.contentDisposition,
    signal,
  });

  return {
    url,
    filename: resolved.filename,
    contentType,
    size: resolved.fileSize,
    isImage,
    width,
    height,
  };
}

/** Result of an outbound single media send. */
export interface SendMediaResult {
  messageId: string;
  url: string;
  type: 'image' | 'file';
  filename: string;
  size: number;
  width?: number;
  height?: number;
}

/**
 * Resolve → presigned-upload → send one image/file to a channel (C1).
 *
 * The delivery target (`channelId` / `channelType`) is supplied by the trusted
 * caller (per-turn session coords), never derived from the media source.
 */
export async function sendMediaToChannel(params: {
  source: string;
  cwdDir: string;
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  filenameHint?: string;
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<SendMediaResult> {
  const resolved = await resolveMediaSource({
    source: params.source,
    cwdDir: params.cwdDir,
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    filenameHint: params.filenameHint,
    maxBytes: params.maxBytes,
    signal: params.signal,
  });
  try {
    const uploaded = await uploadResolvedMedia({
      resolved,
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      signal: params.signal,
    });
    const type = uploaded.isImage ? MessageType.Image : MessageType.File;
    const result = await sendMediaMessage({
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      channelId: params.channelId,
      channelType: params.channelType,
      type,
      url: uploaded.url,
      name: uploaded.filename,
      size: uploaded.size,
      ...(uploaded.width ? { width: uploaded.width } : {}),
      ...(uploaded.height ? { height: uploaded.height } : {}),
      clientMsgNo: generateClientMsgNo(),
      signal: params.signal,
    });
    const messageId = result?.message_id ? String(result.message_id).trim() : '';
    if (!messageId) throw new Error('Octo send API 未返回 message_id');
    return {
      messageId,
      url: uploaded.url,
      type: uploaded.isImage ? 'image' : 'file',
      filename: uploaded.filename,
      size: uploaded.size,
      width: uploaded.width,
      height: uploaded.height,
    };
  } finally {
    await disposeResolvedMedia(resolved);
  }
}

/** Result of an outbound rich-text (mixed text+image) send. */
export interface SendRichTextResult {
  messageId: string;
  imageCount: number;
  failedMedia: Array<{ source: string; error: string }>;
  /** true = a RichText(=14) payload was sent; false = degraded to text + media sends. */
  richText: boolean;
}

/**
 * Send a RichText(=14) mixed text+image message (C2).
 *
 * Every image source is resolved + uploaded first. Images WITH parseable
 * width/height become RichText image blocks (one payload). Anything else
 * (non-image, or an image whose dimensions couldn't be parsed — SVG / corrupt
 * header) is "sideloaded" via a single media send using the already-uploaded
 * URL, since the type-14 contract requires image blocks to carry width/height>0
 * (a dimensionless image would invalidate the whole payload). If no image block
 * survives, we degrade to a text send + sideloads (never returning early after
 * an upload, which would orphan the uploaded object).
 */
export async function sendRichTextToChannel(params: {
  text: string;
  images: string[];
  cwdDir: string;
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<SendRichTextResult> {
  const { text, images, apiUrl, botToken, channelId, channelType } = params;
  const imageBlocks: RichTextBlock[] = [];
  const sideloads: UploadedMedia[] = [];
  const failedMedia: Array<{ source: string; error: string }> = [];
  const resolvedToDispose: ResolvedMedia[] = [];

  try {
    for (const source of images) {
      let resolved: ResolvedMedia | undefined;
      try {
        resolved = await resolveMediaSource({
          source,
          cwdDir: params.cwdDir,
          apiUrl,
          botToken,
          maxBytes: params.maxBytes,
          signal: params.signal,
        });
        resolvedToDispose.push(resolved);
        const uploaded = await uploadResolvedMedia({
          resolved,
          apiUrl,
          botToken,
          signal: params.signal,
        });
        const hasDims = !!(uploaded.width && uploaded.width > 0 && uploaded.height && uploaded.height > 0);
        if (uploaded.isImage && hasDims) {
          imageBlocks.push({
            type: RICH_TEXT_BLOCK_IMAGE,
            url: uploaded.url,
            width: uploaded.width!,
            height: uploaded.height!,
            ...(uploaded.size != null ? { size: uploaded.size } : {}),
            ...(uploaded.filename ? { name: uploaded.filename } : {}),
          });
        } else {
          sideloads.push(uploaded);
        }
      } catch (err) {
        failedMedia.push({ source, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const trimmedText = text.trim();

    // Deliver sideloaded assets (reusing already-uploaded URLs; no re-upload).
    const deliverSideloads = async (): Promise<number> => {
      let delivered = 0;
      for (const uploaded of sideloads) {
        try {
          await sendMediaMessage({
            apiUrl,
            botToken,
            channelId,
            channelType,
            type: uploaded.isImage ? MessageType.Image : MessageType.File,
            url: uploaded.url,
            name: uploaded.filename,
            size: uploaded.size,
            ...(uploaded.width ? { width: uploaded.width } : {}),
            ...(uploaded.height ? { height: uploaded.height } : {}),
            clientMsgNo: generateClientMsgNo(),
            signal: params.signal,
          });
          delivered += 1;
        } catch (err) {
          failedMedia.push({ source: uploaded.url, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return delivered;
    };

    // No image block survived → degrade to a text send + sideloads.
    if (imageBlocks.length === 0) {
      let messageId = '';
      if (trimmedText !== '') {
        const textResult = await sendMessage({
          apiUrl,
          botToken,
          channelId,
          channelType,
          content: text,
          clientMsgNo: generateClientMsgNo(),
          signal: params.signal,
        });
        messageId = textResult?.message_id ? String(textResult.message_id).trim() : '';
      }
      const delivered = await deliverSideloads();
      return { messageId, imageCount: delivered, failedMedia, richText: false };
    }

    // content = [text block?, ...image blocks]. Array order = interleave order.
    const blocks: RichTextBlock[] = [];
    if (trimmedText !== '') blocks.push({ type: RICH_TEXT_BLOCK_TEXT, text });
    blocks.push(...imageBlocks);
    const plain = text + RICH_TEXT_IMAGE_PLACEHOLDER.repeat(imageBlocks.length);

    const sendResult = await sendRichTextMessage({
      apiUrl,
      botToken,
      channelId,
      channelType,
      blocks,
      plain,
      clientMsgNo: generateClientMsgNo(),
      signal: params.signal,
    });
    const messageId = sendResult?.message_id ? String(sendResult.message_id).trim() : '';
    const extra = await deliverSideloads();
    return { messageId, imageCount: imageBlocks.length + extra, failedMedia, richText: true };
  } finally {
    for (const r of resolvedToDispose) await disposeResolvedMedia(r);
  }
}
