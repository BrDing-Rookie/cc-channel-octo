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
 *   1. resolve the media source → a byte body + size + contentType + filename
 *      (`resolveMediaSource`),
 *   2. upload it via a server-issued presigned PUT → a serveable downloadUrl
 *      (`uploadResolvedMedia`),
 *   3. POST the message (`sendMediaMessage` type Image/File, or
 *      `sendRichTextMessage` type 14 for mixed text+image).
 *
 * ── Security (hard acceptance items for this batch) ──────────────────────────
 *   • **Size cap** — every source is bounded by `MAX_OUTBOUND_UPLOAD_BYTES`
 *     BEFORE the presigned PUT (a `data:` URI is measured from its base64 length
 *     without allocating the full Buffer; an HTTP body is capped WHILE streaming;
 *     a local file is stat-checked). The cap is enforced pre-upload so we never
 *     sign / burn an upload on an oversize object.
 *   • **Stream to a temp file** — an HTTP media source is streamed to a temp file
 *     with backpressure + a hard byte cap (never buffered whole in memory), then
 *     the temp file is streamed into the PUT and unlinked in `finally`.
 *   • **SSRF on HTTP media sources** — we REUSE the inbound defense verbatim
 *     (`assertPublicUrl` + `fetchWithRedirectGuard` from url-policy.ts, with the
 *     bot token scoped per-hop to the apiUrl host via `isSameHost`, exactly as
 *     media-inbound.ts does). No second SSRF policy is invented here.
 *   • **Local paths are sandbox-confined** — cc's agent is driven by untrusted IM
 *     users, so (unlike openclaw) an arbitrary absolute path / `file://` URL is
 *     REJECTED. A local source must be a path inside the session cwd sandbox;
 *     the resolved realpath is verified to stay within `cwdDir`, closing an
 *     exfiltration sink (`send /etc/passwd`).
 */

import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { mkdir, unlink, realpath } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { assertPublicUrl, fetchWithRedirectGuard } from './url-policy.js';
import { isSameHost } from './inbound.js';
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

/** Temp dir for HTTP media streamed to disk before upload. */
const UPLOAD_TEMP_DIR = path.join(os.tmpdir(), 'cc-octo-upload');

/** Default timeout for streaming a remote media source to disk. */
const DOWNLOAD_TIMEOUT_MS = 300_000;

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

/** Parse image dimensions from a file by reading only the first 64KB. */
export async function parseImageDimensionsFromFile(
  filePath: string,
  mime: string,
): Promise<{ width: number; height: number } | null> {
  const HEADER_SIZE = 65536;
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(HEADER_SIZE);
    const { bytesRead } = await fh.read(buf, 0, HEADER_SIZE, 0);
    return parseImageDimensions(buf.subarray(0, bytesRead), mime);
  } catch { /* ignore read/parse errors */ }
  finally { await fh?.close(); }
  return null;
}

/**
 * Stream a Web ReadableStream to a file with a strict byte cap + backpressure.
 * Mirrors the inbound download loop (media-inbound.ts) so the two never drift:
 * the first chunk past `maxBytes` cancels the upstream reader, destroys the
 * write stream, unlinks the partial file, and throws.
 */
async function streamToFileWithCap(opts: {
  body: ReadableStream<Uint8Array>;
  destPath: string;
  maxBytes: number;
}): Promise<void> {
  const { body, destPath, maxBytes } = opts;
  const ws = createWriteStream(destPath);
  let totalBytes = 0;

  const streamError = new Promise<never>((_, reject) => {
    ws.on('error', reject);
  });
  streamError.catch(() => {});

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
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

/** A media source resolved to bytes, ready to upload. */
export interface ResolvedMedia {
  /** In-memory body (data: URIs only). Mutually exclusive with bodyPath. */
  fileBuffer?: Buffer;
  /** On-disk body to stream from (local file / downloaded temp). */
  bodyPath?: string;
  fileSize: number;
  contentType: string;
  filename: string;
  /** Path usable for dimension parsing (local file / temp). */
  localFilePath?: string;
  /** A temp file WE created that the caller must unlink after use. */
  tempPath?: string;
}

/** Extension guess for a data: URI content type when no filename is supplied. */
const DATA_URI_EXT: Record<string, string> = {
  'text/markdown': '.md', 'text/plain': '.txt', 'application/pdf': '.pdf',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'application/json': '.json', 'application/zip': '.zip',
  'audio/mpeg': '.mp3', 'video/mp4': '.mp4',
};

/**
 * Resolve a media `source` into bytes ready for a presigned upload.
 *
 * `source` is one of:
 *   - `data:[<mime>][;base64],<data>` — inline; size estimated then buffered.
 *   - `http(s)://…`                   — SSRF-guarded stream to a temp file.
 *   - a path RELATIVE to `cwdDir`     — local file inside the session sandbox.
 *
 * Absolute paths and `file://` URLs are rejected: the untrusted-driven agent
 * must not be able to read arbitrary host files into a group message.
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
  const { source, cwdDir, apiUrl, botToken, filenameHint } = params;
  const maxBytes = params.maxBytes ?? MAX_OUTBOUND_UPLOAD_BYTES;
  const src = source.trim();
  if (!src) throw new Error('媒体来源为空');

  // ── data: URI ──────────────────────────────────────────────────────────
  if (src.startsWith('data:')) {
    const match = src.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
    if (!match) throw new Error('data URI 格式非法');
    const contentType = match[1] || 'application/octet-stream';
    const b64 = match[2];
    // Estimate decoded size from base64 length BEFORE allocating the Buffer,
    // so an oversize data: URI is rejected without the full allocation.
    const trimmed = b64.replace(/\s/g, '');
    const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
    const decodedSize = Math.floor((trimmed.length * 3) / 4) - padding;
    if (decodedSize > maxBytes) {
      throw new Error(`媒体超过大小上限 ${maxBytes} 字节 (约 ${decodedSize} 字节)`);
    }
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > maxBytes) {
      throw new Error(`媒体超过大小上限 ${maxBytes} 字节 (${buf.length} 字节)`);
    }
    const ext = DATA_URI_EXT[contentType] ?? '.bin';
    const filename = filenameHint ? sanitizeFilename(filenameHint) : `file${ext}`;
    return { fileBuffer: buf, fileSize: buf.length, contentType, filename };
  }

  // ── http(s) URL — SSRF-guarded stream to temp file ───────────────────────
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
    // Scope Authorization PER HOP: only send the bot token while the current
    // hop is same-host as apiUrl (a redirect elsewhere drops it) — identical to
    // the inbound download path (media-inbound.ts).
    const resp = await fetchWithRedirectGuard(src, (currentUrl) => {
      const headers: Record<string, string> = {};
      if (isSameHost(currentUrl, apiUrl)) headers.Authorization = `Bearer ${botToken}`;
      return { headers, signal };
    });
    if (!resp.ok) throw new Error(`下载媒体失败 HTTP ${resp.status}`);
    if (!resp.body) throw new Error('媒体响应无内容');

    let contentType = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!contentType || contentType === 'application/octet-stream') {
      contentType = inferContentType(filename);
    }

    await mkdir(UPLOAD_TEMP_DIR, { recursive: true });
    const tempPath = path.join(UPLOAD_TEMP_DIR, `${randomUUID()}-${filename}`);
    await streamToFileWithCap({
      body: resp.body as ReadableStream<Uint8Array>,
      destPath: tempPath,
      maxBytes,
    });
    const size = statSync(tempPath).size;
    if (size === 0) {
      await unlink(tempPath).catch(() => {});
      throw new Error('媒体为空');
    }
    return {
      bodyPath: tempPath,
      tempPath,
      localFilePath: tempPath,
      fileSize: size,
      contentType,
      filename,
    };
  }

  // ── explicit rejection of absolute paths / file:// (sandbox escape) ───────
  if (src.startsWith('file://') || path.isAbsolute(src)) {
    throw new Error(
      '拒绝上传绝对路径 / file:// URL：本地文件必须是会话工作目录内的相对路径',
    );
  }

  // ── local file, relative to the session cwd sandbox ──────────────────────
  const resolvedPath = path.resolve(cwdDir, src);
  // Confine to the sandbox: compare realpaths so a symlink cannot escape.
  let realCwd: string;
  let realTarget: string;
  try {
    realCwd = await realpath(cwdDir);
  } catch {
    realCwd = path.resolve(cwdDir);
  }
  try {
    realTarget = await realpath(resolvedPath);
  } catch {
    throw new Error(`本地文件不存在或不可读: ${src}`);
  }
  const rel = path.relative(realCwd, realTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('拒绝上传会话工作目录之外的文件');
  }
  const st = statSync(realTarget);
  if (!st.isFile()) throw new Error(`不是常规文件: ${src}`);
  if (st.size > maxBytes) {
    throw new Error(`媒体超过大小上限 ${maxBytes} 字节 (${st.size} 字节)`);
  }
  if (st.size === 0) throw new Error('媒体为空');
  const filename = sanitizeFilename(filenameHint ?? path.basename(realTarget));
  return {
    bodyPath: realTarget,
    localFilePath: realTarget,
    fileSize: st.size,
    contentType: inferContentType(filename),
    filename,
  };
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
 * and return its serveable download URL + display metadata. Opens the read
 * stream lazily (after presign succeeds) so a presign failure never dangles an
 * open fd against a temp file.
 */
export async function uploadResolvedMedia(params: {
  resolved: ResolvedMedia;
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<UploadedMedia> {
  const { resolved, apiUrl, botToken, signal } = params;
  const contentType = resolved.contentType || 'application/octet-stream';

  const presign = await getUploadPresign({
    apiUrl,
    botToken,
    filename: resolved.filename,
    fileSize: resolved.fileSize,
    contentType: ensureTextCharset(contentType),
    signal,
  });

  const fileBody: Buffer | NodeJS.ReadableStream =
    resolved.fileBuffer ?? createReadStream(resolved.bodyPath!);
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

  const isImage = contentType.startsWith('image/');
  let width: number | undefined;
  let height: number | undefined;
  if (isImage) {
    const dims = resolved.localFilePath
      ? await parseImageDimensionsFromFile(resolved.localFilePath, contentType)
      : resolved.fileBuffer
        ? parseImageDimensions(resolved.fileBuffer, contentType)
        : null;
    width = dims?.width;
    height = dims?.height;
  }
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
    if (resolved.tempPath) await unlink(resolved.tempPath).catch(() => {});
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
  const tempPaths: string[] = [];

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
        if (resolved.tempPath) tempPaths.push(resolved.tempPath);
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
    for (const tp of tempPaths) await unlink(tp).catch(() => {});
  }
}
