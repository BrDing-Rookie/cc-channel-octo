// Forked from openclaw-channel-octo v1.0.13 (2026-06-04)
// Source: https://github.com/Mininglamp-OSS/openclaw-channel-octo
// Removed: COS upload, OBO, rich text, media, group management,
//          read receipts, bot groups list, group info, mention prefs, space members.
// Restored: thread lifecycle (create/list/get/delete/members/join/leave) — see
//          "Thread Lifecycle" section below; GROUP.md server API (get/update) —
//          see "Group Markdown (GROUP.md)" section below.

import {
  ChannelType,
  MessageType,
  CARD_PROFILE,
  CARD_INTERACTIVE_PROFILE,
  CARD_VERSION,
  type CardProfile,
  type MentionEntity,
  type SendMessageResult,
  type Thread,
  type ThreadMember,
  type TargetCandidate,
  type BotEvent,
  type CardCaps,
  type RichTextBlock,
} from "./types.js";
import { randomUUID } from "node:crypto";
import { OctoApiError } from "./api-error.js";

const DEFAULT_TIMEOUT_MS = 30_000;

// ─── 429 rate-limit retry (ported from openclaw-channel-octo api-fetch.ts) ────
//
// The shared postJson gained a bounded retry ring that engages ONLY on HTTP 429.
// Every other outcome (success, non-429 error, network failure) is unchanged, so
// non-429 callers behave exactly as before. Retry is on by default; discardable /
// self-repeating callers (events poll, ack, typing, heartbeat, read receipts) and
// progress-card frames opt out via `{ retryOn429: false }`.

/** At most three attempts per call: the original plus two retries. */
export const MAX_429_RETRIES = 2;
/**
 * A wait longer than this is not worth holding the call for. Used only to decide whether
 * to retry — never to shorten the server's requested wait, because a shortened wait means
 * going back before the server said we could.
 */
export const MAX_RETRY_AFTER_MS = 10_000;
/** Cumulative backoff sleep budget for one call. Not an end-to-end deadline. */
export const MAX_429_BACKOFF_WAIT_MS = 15_000;

/** Sleep that rejects as soon as the caller's signal aborts, preserving `cause`. */
function backoffSleep(ms: number, signal: AbortSignal | undefined, cause: unknown): Promise<void> {
  const aborted = (): Error =>
    new Error("aborted while backing off from a rate limit", { cause });
  // Checked before arming anything: an abort that landed between the response returning
  // and this call would otherwise be missed entirely and we would serve the full wait.
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      // Surface the rate limiting as the cause; without it the failure site shows only a
      // generic abort and the 429 diagnosis is lost.
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Maximum base64-encoded payload length accepted from /v1/bot/messages/sync.
 * D1/S7 (齐 P0-2): a malicious or buggy server could return a single payload
 * of arbitrary size; Buffer.from(str, 'base64') allocates ~0.75 × input bytes
 * synchronously. Cap at 256 KiB base64 ≈ 192 KiB decoded — well above any
 * legitimate IM message payload.
 */
const MAX_HISTORICAL_PAYLOAD_BASE64_LEN = 256 * 1024;

/**
 * Generate a client-side idempotency key (UUID) for outbound messages.
 *
 * WuKongIM uses client_msg_no for server-side dedup — identical client_msg_no
 * values result in only one stored message.
 */
export function generateClientMsgNo(): string {
  return randomUUID();
}

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
};

/**
 * Parse JSON with int64 message_id protection.
 * Converts 16+ digit numeric message_id values to strings before JSON.parse
 * to prevent JavaScript precision loss for IDs exceeding Number.MAX_SAFE_INTEGER.
 *
 * Exported so other inbound paths parse Octo JSON with the same int64 safety as
 * the REST client.
 */
export function parseOctoJson<T>(text: string): T {
  const safeText = text.replace(
    /"message_id"\s*:\s*(\d{16,})/g,
    '"message_id":"$1"',
  );
  return JSON.parse(safeText) as T;
}

export async function postJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: { retryOn429?: boolean },
): Promise<T | undefined> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const retryOn429 = opts?.retryOn429 ?? true;
  let waited = 0;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason;

    // Per-attempt signal: a caller-provided signal is honored as-is (it carries the
    // caller's own budget), but the no-signal default MUST be rebuilt each attempt — an
    // `AbortSignal.timeout` created once would already be spent on a retry. For the
    // common single-attempt (success / non-429) path this is byte-identical to the
    // previous `signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS)`.
    const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...DEFAULT_HEADERS,
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify(payload),
      signal: effectiveSignal,
    });

    if (response.ok) {
      const text = await response.text();
      if (!text) return undefined;
      try {
        return parseOctoJson<T>(text);
      } catch {
        throw new Error(`Octo API ${path} returned invalid JSON: ${text.slice(0, 200)}`);
      }
    }

    const body = await response.text().catch(() => "");
    const err = OctoApiError.from(response, path, body);

    // Only a rate limit ever enters the retry ring; every other status is thrown
    // immediately, exactly as before. The thrown message is unchanged
    // (`Octo API <path> failed (<status>): <body>`), so status-parsing callers keep working.
    if (!err.isRateLimited) throw err;

    // Logged on every rate limit, including the one we give up on: the scope and the
    // remaining count are the only way to tell which bucket ran dry and whose traffic
    // filled it, and they are discarded once this error leaves here.
    console.warn(
      `octo: rate limited on ${path} (scope=${err.rateLimitScope ?? "?"} ` +
        `remaining=${err.rateLimitRemaining ?? "?"} retry_after=${err.retryAfterMs}ms) ` +
        `attempt=${attempt + 1}/${retryOn429 ? MAX_429_RETRIES + 1 : 1}`,
    );

    if (!retryOn429 || attempt >= MAX_429_RETRIES) throw err;
    // A wait this long is the server telling us to go away, not to try again shortly.
    // Clamping it down instead would just return before it was ready for us.
    if (err.retryAfterMs > MAX_RETRY_AFTER_MS) throw err;

    // Jitter only ever adds. Retry-After is the earliest acceptable retry time, so a
    // downward jitter would put us back on the server before it allowed it.
    const delay = Math.round(err.retryAfterMs * (1 + Math.random() * 0.25));
    if (waited + delay > MAX_429_BACKOFF_WAIT_MS) throw err;

    await backoffSleep(delay, signal, err);
    waited += delay;
  }
}

// ─── Message Sending ────────────────────────────────────────────────────────

export async function sendMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  content: string;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
  replyMsgId?: string;
  clientMsgNo?: string;
  /**
   * E2 (OBO v2): grantor uid to send this message on behalf of. Forwarded as the
   * wire `on_behalf_of` field so the server routes the reply as the grantor's
   * persona to the origin channel. Only ever the CONFIGURED grantor
   * (`config.onBehalfOf`) — never a value taken from an inbound payload.
   */
  onBehalfOf?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  const payload: Record<string, unknown> = {
    type: MessageType.Text,
    content: params.content,
  };
  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0) ||
    params.mentionAll
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    if (params.mentionAll) {
      mention.all = 1;
    }
    payload.mention = mention;
  }
  if (params.replyMsgId) {
    payload.reply = { message_id: params.replyMsgId };
  }
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
    ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {}),
  }, params.signal);
}

/**
 * Send a media message (image or file) to a channel.
 *
 * `type` selects the wire shape: Image(=2) carries width/height/name/size,
 * File(=8) carries name/size. `url` MUST be a URL the server can serve — in
 * practice the `downloadUrl` returned by {@link uploadFileToPresignedUrl} after
 * a presigned upload (C3). This function only assembles + POSTs the payload; it
 * does NOT upload — see media-outbound.ts for the resolve→upload→send path.
 */
export async function sendMediaMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  type: MessageType;
  url: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  // Last-line guard: never POST an empty channel_id — the server answers an
  // opaque 500. Callers resolve/validate the target up front; this is defense
  // in depth for any path that bypasses them.
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a media message");
  }
  const payload: Record<string, unknown> = {
    type: params.type,
    url: params.url,
  };
  // Image(=2) needs width/height/name/size; File(=8) needs name/size.
  if (params.type === MessageType.Image) {
    if (params.width) payload.width = params.width;
    if (params.height) payload.height = params.height;
    if (params.name) payload.name = params.name;
    if (params.size != null) payload.size = params.size;
  } else {
    if (params.name) payload.name = params.name;
    if (params.size != null) payload.size = params.size;
  }
  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0)
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    payload.mention = mention;
  }
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
  }, params.signal);
}

/**
 * Send a RichText(=14) mixed text+image message to a channel.
 *
 * A single payload carries an ordered `content` array of {@link RichTextBlock}
 * (array order = visual interleave order), so an image + caption lands as ONE
 * message instead of a text send followed by a media send. Contract (octo-lib
 * richtext.go): `content` is required + non-empty; a text block's `text` must be
 * non-empty; an image block's `url` must be http/https with width/height > 0.
 * The caller assembles + validates blocks; the server is authoritative. `plain`
 * is an optional degraded-client fallback the server reauthors from `content`.
 */
export async function sendRichTextMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  blocks: RichTextBlock[];
  plain?: string;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
  replyMsgId?: string;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a rich text message");
  }
  if (!Array.isArray(params.blocks) || params.blocks.length === 0) {
    throw new Error("octo: sendRichTextMessage requires a non-empty blocks array");
  }
  const payload: Record<string, unknown> = {
    type: MessageType.RichText,
    content: params.blocks,
  };
  if (typeof params.plain === "string") {
    payload.plain = params.plain;
  }
  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0) ||
    params.mentionAll
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    if (params.mentionAll) {
      mention.all = 1;
    }
    payload.mention = mention;
  }
  if (params.replyMsgId) {
    payload.reply = { message_id: params.replyMsgId };
  }
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
  }, params.signal);
}

/**
 * Get STS temporary credentials for direct COS upload.
 * GET /v1/bot/upload/credentials?filename=<encoded>
 *
 * Returns short-lived (typically 1h) credentials scoped to a single key.
 * cc only uses this to probe the media CDN host (see index.ts); actual uploads
 * are performed by the agent's octo-cli skill, not by cc itself.
 */
export async function getUploadCredentials(params: {
  apiUrl: string;
  botToken: string;
  filename: string;
  signal?: AbortSignal;
}): Promise<{
  bucket: string;
  region: string;
  key: string;
  credentials: {
    tmpSecretId: string;
    tmpSecretKey: string;
    sessionToken: string;
  };
  startTime: number;
  expiredTime: number;
  cdnBaseUrl?: string;
}> {
  const base = params.apiUrl.replace(/\/+$/, "");
  const url = `${base}/v1/bot/upload/credentials?filename=${encodeURIComponent(params.filename)}`;
  const effectiveSignal = params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: effectiveSignal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // P1 from PR#34 review: server may echo request headers (incl. Authorization
    // bearer token) on some error responses. Cap at 200 chars and strip any
    // "Authorization" / "Bearer" tokens defensively before surfacing.
    const sanitized = text
      .slice(0, 200)
      .replace(/Bearer\s+\S+/gi, "Bearer ***")
      .replace(/(authorization"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1***");
    throw new Error(`Octo API /v1/bot/upload/credentials failed (${response.status}): ${sanitized || response.statusText}`);
  }
  const data = await response.json() as Record<string, unknown>;
  // Validate required fields to catch backend API changes early.
  const missing = ['bucket', 'region', 'key', 'credentials'].filter(k => !data[k]);
  if (missing.length > 0) {
    throw new Error(`Octo API /v1/bot/upload/credentials returned incomplete response: missing ${missing.join(', ')}`);
  }
  const creds = data.credentials as Record<string, unknown>;
  if (!creds.tmpSecretId || !creds.tmpSecretKey || !creds.sessionToken) {
    throw new Error("Octo API /v1/bot/upload/credentials returned incomplete credentials");
  }
  return data as {
    bucket: string;
    region: string;
    key: string;
    credentials: { tmpSecretId: string; tmpSecretKey: string; sessionToken: string; };
    startTime: number;
    expiredTime: number;
    cdnBaseUrl?: string;
  };
}

// ─── Typing / Heartbeat ─────────────────────────────────────────────────────

export async function sendTyping(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/typing", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    // A discardable hint, re-sent every few seconds while the model works. Retrying it
    // through the 429 backoff would only hold the caller for a frame nothing depends on.
  }, params.signal, { retryOn429: false });
}

export async function sendHeartbeat(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<void> {
  // Liveness ping, re-sent on its own cadence. A missed one is picked up by the next
  // tick, so it opts out of the 429 backoff rather than stalling the heartbeat loop.
  await postJson(params.apiUrl, params.botToken, "/v1/bot/heartbeat", {}, params.signal, { retryOn429: false });
}

// ─── Bot Registration ───────────────────────────────────────────────────────

export async function registerBot(params: {
  apiUrl: string;
  botToken: string;
  forceRefresh?: boolean;
  agentPlatform?: string;
  agentVersion?: string;
  signal?: AbortSignal;
}): Promise<{
  robot_id: string;
  im_token: string;
  ws_url: string;
  api_url: string;
  owner_uid: string;
  owner_channel_id: string;
}> {
  const path = params.forceRefresh
    ? "/v1/bot/register?force_refresh=true"
    : "/v1/bot/register";
  const body: Record<string, string> = {};
  if (params.agentPlatform) body.agent_platform = params.agentPlatform;
  if (params.agentVersion) body.agent_version = params.agentVersion;
  const result = await postJson<{
    robot_id: string;
    im_token: string;
    ws_url: string;
    api_url: string;
    owner_uid: string;
    owner_channel_id: string;
  }>(params.apiUrl, params.botToken, path, body, params.signal);
  if (!result) throw new Error("Octo bot registration returned empty response");
  return result;
}

/**
 * GET request helper with consistent error handling, timeout, and int64 protection.
 */
async function getJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${botToken}`,
    },
    signal: effectiveSignal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  const text = await resp.text();
  if (!text) return {} as T;
  return parseOctoJson<T>(text);
}

// ─── Read Receipt ──────────────────────────────────────────────────────────

export async function sendReadReceipt(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  messageIds: string[];
  signal?: AbortSignal;
}): Promise<void> {
  // Only send message-level ids that are actually present. An empty / blank id
  // makes the server resolve a message_seq it cannot find, which the IM backend
  // rejects — so omit message_ids entirely when there is nothing valid to ack
  // (the request then just clears the conversation unread badge).
  const ids = (params.messageIds ?? []).filter((id) => id && id.trim() !== '');
  await postJson(params.apiUrl, params.botToken, '/v1/bot/readReceipt', {
    channel_id: params.channelId,
    channel_type: params.channelType,
    ...(ids.length > 0 ? { message_ids: ids } : {}),
    // Nothing downstream depends on this landing (same reasoning as typing), so it
    // opts out of the 429 backoff.
  }, params.signal, { retryOn429: false });
}

// ─── Group Members ──────────────────────────────────────────────────────────

export interface GroupMember {
  uid: string;
  name: string;
  role: number;
  robot?: number;
  status?: number;
  [key: string]: unknown;
}

export async function getGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
}): Promise<GroupMember[]> {
  const data = await getJson<Record<string, unknown>>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${params.groupNo}/members`,
  );
  const members = Array.isArray(data?.members)
    ? data.members
    : Array.isArray(data)
      ? data
      : [];
  return members as GroupMember[];
}



// ─── User Info ──────────────────────────────────────────────────────────────

export async function fetchUserInfo(params: {
  apiUrl: string;
  botToken: string;
  uid: string;
}): Promise<{ uid: string; name: string; avatar?: string } | null> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/user/info?uid=${encodeURIComponent(params.uid)}`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.botToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.status === 404) {
      return null;
    }
    if (!resp.ok) {
      console.error(`octo: fetchUserInfo(${params.uid}) failed: ${resp.status}`);
      return null;
    }
    const data = await resp.json() as { uid?: string; name?: string; avatar?: string };
    if (data?.name) {
      return { uid: data.uid ?? params.uid, name: data.name, avatar: data.avatar };
    }
    return null;
  } catch (err) {
    console.error(`octo: fetchUserInfo(${params.uid}) error: ${String(err)}`);
    return null;
  }
}

// ─── Channel Message History (G4) ──────────────────────────────────────────

/** Historical message returned by /v1/bot/messages/sync. */
export interface HistoricalMessage {
  from_uid: string;
  from_name?: string;
  content?: string;
  timestamp: number;
  message_id?: string;
  message_seq?: number;
  /** Numeric MessageType (1=Text, 2=Image, 8=File, 14=RichText, etc.) */
  type?: number;
  url?: string;
  name?: string;
  /** Decoded full payload (server sends base64, we decode + JSON.parse). */
  payload?: Record<string, unknown>;
}

/**
 * Pull recent messages for a channel via the WuKongIM sync endpoint.
 *
 * Used by G4 to backfill conversation history when the local SQLite cache is
 * empty or sparse (e.g. cold start, restored snapshot). The server payload is
 * base64-encoded JSON; we decode it inline so callers get a clean object.
 *
 * Returns `[]` on any failure — the agent runs fine without history.
 */
export async function getChannelMessages(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: number;
  limit?: number;
  startMessageSeq?: number;
  endMessageSeq?: number;
  signal?: AbortSignal;
}): Promise<HistoricalMessage[]> {
  try {
    const result = await postJson<{ messages?: Array<Record<string, unknown>> }>(
      params.apiUrl,
      params.botToken,
      '/v1/bot/messages/sync',
      {
        channel_id: params.channelId,
        channel_type: params.channelType,
        limit: params.limit ?? 20,
        start_message_seq: params.startMessageSeq ?? 0,
        end_message_seq: params.endMessageSeq ?? 0,
        pull_mode: 1, // 1 = pull newer messages
      },
      params.signal,
    );
    const messages = result?.messages ?? [];
    // D1/S7 (齐 P0-2): client-side cap on returned message count. The server
    // could return more than `limit` requested (bug or malice); we map +
    // decode each item which is O(payload size) per message.
    const cap = params.limit ?? 20;
    const limited = messages.length > cap ? messages.slice(0, cap) : messages;
    return limited.map((m) => {
      let payload: Record<string, unknown> | undefined;
      if (typeof m.payload === 'string') {
        // D1/S7 (齐 P0-2): cap base64 payload size before decoding. A 100 MB
        // base64 string would force Buffer.from to allocate ~75 MB synchronously.
        // 256 KiB decoded ≈ 192 KiB binary, well above any legitimate IM payload.
        if (m.payload.length > MAX_HISTORICAL_PAYLOAD_BASE64_LEN) {
          console.warn(
            `octo: getChannelMessages dropping oversized payload (${m.payload.length} base64 chars > ${MAX_HISTORICAL_PAYLOAD_BASE64_LEN})`,
          );
        } else {
          try {
            payload = JSON.parse(Buffer.from(m.payload, 'base64').toString('utf-8'));
          } catch {
            // Leave payload undefined if decoding fails
          }
        }
      } else if (m.payload && typeof m.payload === 'object') {
        payload = m.payload as Record<string, unknown>;
      }
      return {
        from_uid: String(m.from_uid ?? ''),
        from_name: typeof m.from_name === 'string' ? m.from_name : undefined,
        // C1 / P1.5 (Stage 6): WuKongIM /v1/bot/messages/sync ships per-message
        // content / type / url / name INSIDE the base64-encoded payload, not at
        // the top level. Without merging the decoded payload up, every Text
        // history row had `content: undefined`, so seedHistoryFromApi treated
        // every backfilled message as empty and skipped the placeholder branch
        // — G4 backfill was effectively a no-op for Text.
        //
        // Strategy: prefer the top-level field when it is a usable string /
        // number, otherwise fall back to the decoded payload field. We never
        // overwrite a populated top-level value with a payload value, so this
        // is a strict superset of the previous behavior.
        content:
          typeof m.content === 'string' && m.content !== ''
            ? m.content
            : typeof payload?.content === 'string'
              ? payload.content
              : undefined,
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : 0,
        message_id: typeof m.message_id === 'string' ? m.message_id : undefined,
        message_seq: typeof m.message_seq === 'number' ? m.message_seq : undefined,
        type:
          typeof m.type === 'number'
            ? m.type
            : typeof payload?.type === 'number'
              ? payload.type
              : undefined,
        url:
          typeof m.url === 'string'
            ? m.url
            : typeof payload?.url === 'string'
              ? payload.url
              : undefined,
        name:
          typeof m.name === 'string'
            ? m.name
            : typeof payload?.name === 'string'
              ? payload.name
              : undefined,
        payload,
      };
    });
  } catch (err) {
    console.error(`octo: getChannelMessages error: ${String(err)}`);
    return [];
  }
}

// ─── Thread Lifecycle ────────────────────────────────────────────────────────
//
// Restores the bot thread (CommunityTopic) lifecycle endpoints that were removed
// at fork time (see file header). Path / method / auth are a verbatim restore of
// openclaw-channel-octo api-fetch.ts (createThread … leaveThread); each call is
// routed through this client's postJson/getJson/requestNoBody helpers so it
// shares the same timeout, Bearer auth, int64-safe JSON parse, and error-message
// format as the rest of the API surface.

/**
 * Issue a request that carries neither a request body nor a meaningful response
 * body (thread delete / join / leave). Mirrors postJson's timeout, Bearer auth,
 * and error-message format. A 2xx with an empty body resolves to void.
 */
async function requestNoBody(
  apiUrl: string,
  botToken: string,
  method: "POST" | "DELETE",
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${botToken}` },
    signal: effectiveSignal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
}

/**
 * Serialize an int64 id (e.g. a snowflake message id) into a request body as a
 * *bare JSON number* with full precision preserved.
 *
 * The Octo backend requires `source_message_id` to be a JSON number — a quoted
 * string is rejected with 400 request_invalid. But a 19-digit snowflake exceeds
 * Number.MAX_SAFE_INTEGER (2^53-1), so the value must never pass through a JS
 * `number`, which would silently truncate it. We therefore keep it as a string
 * end-to-end and hand it to JSON.stringify verbatim via JSON.rawJSON (Node >=21),
 * yielding wire JSON such as `"source_message_id":2071497871135346688`.
 *
 * JSON.rawJSON is not in the ES2022 lib typings yet, so it is accessed through a
 * narrow cast rather than `any`.
 */
function rawInt64(value: string): unknown {
  if (!/^-?[0-9]+$/.test(value)) {
    throw new Error(`int64 id must be a base-10 integer string, got: ${value}`);
  }
  return (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(value);
}

/** Create a thread under a parent group. POST /v1/bot/groups/{groupNo}/threads */
export async function createThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  name: string;
  /** Optional: anchor the thread to the message it was started from. Accepted as
   *  a string to stay int64-safe, but emitted on the wire as a bare JSON number
   *  (the server rejects a quoted value); see rawInt64. */
  sourceMessageId?: string;
  signal?: AbortSignal;
}): Promise<Thread | undefined> {
  const body: Record<string, unknown> = { name: params.name };
  if (params.sourceMessageId != null) body.source_message_id = rawInt64(params.sourceMessageId);
  return await postJson<Thread>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads`,
    body,
    params.signal,
  );
}

/** List threads under a parent group. GET /v1/bot/groups/{groupNo}/threads */
export async function listThreads(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  signal?: AbortSignal;
}): Promise<Thread[]> {
  const data = await getJson<Record<string, unknown>>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads`,
    params.signal,
  );
  // Tolerate both a bare array and a `{ threads: [...] }` envelope, mirroring
  // getGroupMembers' defensive shape handling.
  const threads = Array.isArray(data?.threads)
    ? data.threads
    : Array.isArray(data)
      ? data
      : [];
  return threads as Thread[];
}

/** Get a single thread. GET /v1/bot/groups/{groupNo}/threads/{shortId} */
export async function getThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
}): Promise<Thread> {
  return await getJson<Thread>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}`,
    params.signal,
  );
}

/** Delete a thread. DELETE /v1/bot/groups/{groupNo}/threads/{shortId} */
export async function deleteThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await requestNoBody(
    params.apiUrl,
    params.botToken,
    "DELETE",
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}`,
    params.signal,
  );
}

/** List a thread's members. GET /v1/bot/groups/{groupNo}/threads/{shortId}/members */
export async function listThreadMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
}): Promise<ThreadMember[]> {
  const data = await getJson<Record<string, unknown>>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/members`,
    params.signal,
  );
  const members = Array.isArray(data?.members)
    ? data.members
    : Array.isArray(data)
      ? data
      : [];
  return members as ThreadMember[];
}

/** Join a thread. POST /v1/bot/groups/{groupNo}/threads/{shortId}/join */
export async function joinThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await requestNoBody(
    params.apiUrl,
    params.botToken,
    "POST",
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/join`,
    params.signal,
  );
}

/** Leave a thread. POST /v1/bot/groups/{groupNo}/threads/{shortId}/leave */
export async function leaveThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await requestNoBody(
    params.apiUrl,
    params.botToken,
    "POST",
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/leave`,
    params.signal,
  );
}

// ─── Group Markdown (GROUP.md) ───────────────────────────────────────────────
//
// Restores the GROUP.md server API removed at fork time (see file header). A
// group's GROUP.md is operator-authored persona / rules stored server-side; the
// gateway fetches it (server-first) and injects it as a trusted instruction
// block into the agent's system prompt. Path / method / auth / response shape
// are a verbatim restore of openclaw-channel-octo api-fetch.ts
// (getGroupMd / updateGroupMd), routed through this client's getJson helper so
// GET shares the same timeout, Bearer auth, int64-safe JSON parse and
// error-message format as the rest of the API surface.

/** Server GROUP.md payload returned by GET /v1/bot/groups/{groupNo}/md. */
export interface GroupMd {
  content: string;
  version: number;
  updated_at: string | null;
  updated_by: string;
}

/**
 * Fetch a group's server-side GROUP.md. GET /v1/bot/groups/{groupNo}/md.
 *
 * Throws on any non-2xx (including 404 "no GROUP.md set") — the caller decides
 * how to degrade. The server-first fetch orchestrator (group-md.ts) catches and
 * falls back to the local instruction file, so a 404 cleanly downgrades to local.
 */
export async function getGroupMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  signal?: AbortSignal;
}): Promise<GroupMd> {
  return await getJson<GroupMd>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/md`,
    params.signal,
  );
}

/**
 * Server THREAD.md payload returned by GET /v1/bot/groups/{groupNo}/threads/{shortId}/md.
 *
 * Same shape as {@link GroupMd} — the thread markdown endpoint is symmetric to
 * the group one (verified against the live backend: 200 with
 * `{content, version, updated_at, updated_by}`). A thread carries its OWN
 * operator-authored instructions; it does NOT inherit the parent group's GROUP.md.
 */
export interface ThreadMd {
  content: string;
  version: number;
  updated_at: string | null;
  updated_by: string;
}

/**
 * Fetch a thread's server-side THREAD.md.
 * GET /v1/bot/groups/{groupNo}/threads/{shortId}/md.
 *
 * The endpoint is symmetric to {@link getGroupMd} (group md = `.../groups/{groupNo}/md`;
 * thread md = `.../groups/{groupNo}/threads/{shortId}/md`), sharing the same
 * getJson timeout / Bearer auth / int64-safe JSON parse / error-message format.
 *
 * Throws on any non-2xx (including 404 "no THREAD.md set") — the caller
 * (group-md.ts thread branch) catches and falls back to the local
 * `<shortId>.md` file, mirroring the group server-first degrade path.
 */
export async function getThreadMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
}): Promise<ThreadMd> {
  return await getJson<ThreadMd>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/md`,
    params.signal,
  );
}

/**
 * Update a group's server-side GROUP.md (requires bot_admin permission).
 * PUT /v1/bot/groups/{groupNo}/md, body `{ content }` → `{ version }`.
 *
 * NOTE (P2-A scope): this client function is restored alongside getGroupMd, but
 * is intentionally NOT wired into any write-back path here — the PUT trigger
 * chain is owned by a separate work item. Mirrors postJson's timeout, Bearer
 * auth and error-message format.
 */
export async function updateGroupMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  content: string;
  signal?: AbortSignal;
}): Promise<{ version: number }> {
  const path = `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/md`;
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}`;
  const effectiveSignal = params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${params.botToken}`,
    },
    body: JSON.stringify({ content: params.content }),
    signal: effectiveSignal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  const text = await resp.text();
  if (!text) return { version: 0 };
  return parseOctoJson<{ version: number }>(text);
}

/**
 * Update a thread's server-side THREAD.md.
 * PUT /v1/bot/groups/{groupNo}/threads/{shortId}/md, body `{ content }` → `{ version }`.
 *
 * Symmetric to {@link updateGroupMd} (group md = `.../groups/{groupNo}/md`;
 * thread md = `.../groups/{groupNo}/threads/{shortId}/md`) and to the already-
 * wired {@link getThreadMd} GET. Path / body / response were confirmed against
 * the official Octo web client's data source (GET/PUT/DELETE
 * `groups/{groupNo}/threads/{shortId}/md`, body `{ content }`, reply
 * `{ version }`) — the same trio the group md endpoint exposes. Like the group
 * PUT there is NO compare-and-swap: the body carries only `content`, so the
 * server is last-write-wins (the write-back coordinator serializes same-thread
 * writes to stop this gateway racing itself — see ThreadMdWriteback).
 *
 * Mirrors postJson's timeout, Bearer auth and error-message format.
 */
export async function updateThreadMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  content: string;
  signal?: AbortSignal;
}): Promise<{ version: number }> {
  const path = `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/md`;
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}`;
  const effectiveSignal = params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${params.botToken}`,
    },
    body: JSON.stringify({ content: params.content }),
    signal: effectiveSignal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  const text = await resp.text();
  if (!text) return { version: 0 };
  return parseOctoJson<{ version: number }>(text);
}

// ─── Interactive Card (type 17) ──────────────────────────────────────────────
//
// Wire-layer restore of the card senders removed at fork time. Path / method /
// auth / payload shape mirror openclaw-channel-octo api-fetch.ts (octo-server
// PR #525 P1 / #548). Cards ride on `/v1/bot/sendMessage` (send) and
// `/v1/bot/message/edit` (edit) with `payload.type = 17`. Each sender threads the
// `retryOn429` knob through to postJson's 429 backoff ring (default on): a
// user-visible card has to land, so it keeps the default; the progress-card driver
// passes false for discardable mid-frames (see card-progress.ts). The wire contract
// (type17 / profile upgrade / card_seq CAS / transient) lives entirely in payload
// assembly and is preserved regardless of the knob.

/** True when a card tree contains any interactive node (Input.* / Action.Submit). */
function cardContainsInteraction(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => cardContainsInteraction(item, seen));
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string" && (
    record.type.startsWith("Input.") || record.type === "Action.Submit"
  )) return true;
  return Object.values(record).some((item) => cardContainsInteraction(item, seen));
}

/**
 * Resolve the wire profile for a card. A display card uses the requested profile
 * (default `octo/v1`); any card carrying interaction is force-upgraded to
 * `octo/v2` regardless of what the caller asked for.
 */
function resolveCardProfile(card: Record<string, unknown>, requested?: CardProfile): CardProfile {
  return cardContainsInteraction(card) ? CARD_INTERACTIVE_PROFILE : (requested ?? CARD_PROFILE);
}

function buildCardMention(params: {
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
}): Record<string, unknown> | undefined {
  if (
    !(params.mentionUids && params.mentionUids.length > 0) &&
    !(params.mentionEntities && params.mentionEntities.length > 0) &&
    !params.mentionAll
  ) {
    return undefined;
  }
  const mention: Record<string, unknown> = {};
  if (params.mentionUids && params.mentionUids.length > 0) mention.uids = params.mentionUids;
  if (params.mentionEntities && params.mentionEntities.length > 0) mention.entities = params.mentionEntities;
  if (params.mentionAll) mention.all = 1;
  return mention;
}

/**
 * Send an InteractiveCard(=17) message. `card` is standard Adaptive Cards 1.5
 * JSON (schema validation is server-authoritative in pkg/cardmsg — this function
 * only assembles the envelope). `card_version` is fixed at `1.5`; the profile is
 * `octo/v1` unless the card carries `Input.*` / `Action.Submit`, which upgrades
 * it to `octo/v2`. Callers should feature-detect via getCardProfile first (D12).
 * `onBehalfOf` is forwarded when set, but OBO + type-17 is rejected server-side
 * (P1 Decision 2b), so it is only meaningful for regular bot card sends.
 */
export async function sendCardMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  card: Record<string, unknown>;
  /** Display cards default to octo/v1; Input.* / Action.Submit auto-upgrade to octo/v2. */
  profile?: CardProfile;
  plain?: string;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
  replyMsgId?: string;
  onBehalfOf?: string;
  clientMsgNo?: string;
  signal?: AbortSignal;
  /**
   * Forwarded to postJson's 429 backoff ring. Defaults to true — a user-visible card
   * has to land. A discardable progress mid-frame passes false so it is not held while
   * we back off (rate limiting for those frames is handled by the cooldown gate in
   * card-progress.ts).
   */
  retryOn429?: boolean;
}): Promise<SendMessageResult | undefined> {
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a message");
  }
  const payload: Record<string, unknown> = {
    type: MessageType.InteractiveCard,
    card: params.card,
    profile: resolveCardProfile(params.card, params.profile),
    card_version: CARD_VERSION,
  };
  if (typeof params.plain === "string") payload.plain = params.plain;
  const mention = buildCardMention(params);
  if (mention) payload.mention = mention;
  if (params.replyMsgId) payload.reply = { message_id: params.replyMsgId };
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
    ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {}),
  }, params.signal, { retryOn429: params.retryOn429 ?? true });
}

export interface CardTemplateRef {
  id: string;
  version: string;
}

/** Effective per-bot card policy returned by GET /v1/bot/card/profile. */
export interface BotCardConfig {
  card_enabled: boolean;
  display_enabled: boolean;
  interaction_enabled: boolean;
  reasoning_enabled: boolean;
  reasoning_template_ref: CardTemplateRef | null;
}

export interface CardTemplateViewCapability {
  name: string;
  states: string[];
  wire_profile: string;
  submit_actions: string[];
}

export interface CardTemplateCapability {
  id: string;
  version: string;
  views: CardTemplateViewCapability[];
}

export interface CardTemplatingCapability {
  supported: boolean;
  wire: string;
  templates: CardTemplateCapability[];
}

/**
 * Validate a Registry template frame before it goes on the wire: templateRef must
 * be exactly { id, version } (both non-empty strings), state a non-empty string,
 * and data a plain object whose own `state` equals `state`.
 */
function validateTemplateFrame(params: {
  templateRef: CardTemplateRef;
  state: string;
  data: object;
}): void {
  const templateRef = params.templateRef as unknown;
  if (templateRef === null || typeof templateRef !== "object" || Array.isArray(templateRef)) {
    throw new Error("octo: templateRef must contain exactly id and version");
  }
  const templateRefKeys = Object.keys(templateRef);
  if (templateRefKeys.length !== 2 ||
      !templateRefKeys.includes("id") ||
      !templateRefKeys.includes("version")) {
    throw new Error("octo: templateRef must contain exactly id and version");
  }
  const { id, version } = templateRef as Record<string, unknown>;
  if (typeof id !== "string" || typeof version !== "string" || !id.trim() || !version.trim()) {
    throw new Error("octo: templateRef id/version are required");
  }
  if (typeof params.state !== "string" || !params.state.trim()) {
    throw new Error("octo: template state is required");
  }
  const data = params.data as unknown;
  if (data === null || typeof data !== "object" || Array.isArray(data) ||
      (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null) ||
      !Object.hasOwn(data, "state")) {
    throw new Error("octo: data must be a plain object with own state");
  }
  if ((data as { state: unknown }).state !== params.state) {
    throw new Error("octo: data.state must match state");
  }
}

/**
 * Send one Registry-authored type-17 card (no render-owned card body). OBO is
 * intentionally absent: Registry template cards are bot-authored, and OBO +
 * type-17 is rejected server-side (P1 Decision 2b).
 */
export async function sendTemplateCardMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  templateRef: CardTemplateRef;
  state: string;
  data: object;
  clientMsgNo?: string;
  signal?: AbortSignal;
  /**
   * Forwarded to postJson's 429 backoff ring. Defaults to true — a user-visible card
   * has to land. A discardable progress mid-frame passes false (see card-progress.ts).
   */
  retryOn429?: boolean;
}): Promise<SendMessageResult | undefined> {
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a message");
  }
  validateTemplateFrame(params);
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload: {
      type: MessageType.InteractiveCard,
      template_ref: params.templateRef,
      state: params.state,
      data: params.data,
    },
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
  }, params.signal, { retryOn429: params.retryOn429 ?? true });
}

/**
 * Edit an InteractiveCard(=17) message in place (D6 frame rewrite, PR #548).
 * `POST /v1/bot/message/edit`; `content_edit` is the complete type-17 envelope
 * serialized as a JSON string (symmetric with send). Only the bot's own,
 * un-recalled cards can be edited.
 *
 *   - `cardSeq` is the interactive multi-frame monotonic sequence (CAS): the
 *     server rejects a stale / out-of-order frame. Kept a JS safe integer here;
 *     positive-safe-integer is enforced before it goes on the wire.
 *   - `transient` marks a progress mid-frame so it does NOT enter the D10 revision
 *     history (avoids the cap-20 history being flooded by progress noise); a
 *     terminal frame omits it and is recorded.
 */
export async function editCardMessage(params: {
  apiUrl: string;
  botToken: string;
  messageId: string;
  channelId: string;
  channelType: ChannelType;
  card: Record<string, unknown>;
  /** Defaults to octo/v1; Input.* / Action.Submit auto-upgrade to octo/v2. */
  profile?: CardProfile;
  /** Monotonic frame sequence for interactive multi-frame edits (CAS). */
  cardSeq?: number;
  plain?: string;
  /** Progress mid-frames pass true → excluded from D10 revision history. */
  transient?: boolean;
  onBehalfOf?: string;
  signal?: AbortSignal;
  /**
   * Forwarded to postJson's 429 backoff ring. Defaults to true — a user-visible card
   * has to land. A discardable progress mid-frame passes false (see card-progress.ts).
   */
  retryOn429?: boolean;
}): Promise<void> {
  if (!params.messageId) {
    throw new Error("octo: messageId is required to edit a card");
  }
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to edit a card");
  }
  const envelope: Record<string, unknown> = {
    type: MessageType.InteractiveCard,
    card: params.card,
    profile: resolveCardProfile(params.card, params.profile),
    card_version: CARD_VERSION,
  };
  if (typeof params.plain === "string") envelope.plain = params.plain;
  if (params.cardSeq !== undefined) {
    if (!Number.isSafeInteger(params.cardSeq) || params.cardSeq <= 0) {
      throw new Error("octo: cardSeq must be a positive safe integer");
    }
    envelope.card_seq = params.cardSeq;
  }
  if (params.transient) envelope.transient = true;
  await postJson(params.apiUrl, params.botToken, "/v1/bot/message/edit", {
    message_id: params.messageId,
    channel_id: params.channelId,
    channel_type: params.channelType,
    content_edit: JSON.stringify(envelope),
    ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {}),
  }, params.signal, { retryOn429: params.retryOn429 ?? true });
}

// ─── Card Profile / Capability Negotiation (D12, A1) ─────────────────────────

/**
 * D12 producer capability-discovery manifest (octo-server PR #525 P2, additive).
 */
export interface CardProfileManifest {
  /**
   * Whether the D12 manifest endpoint is deployed and answered (non-404). When
   * false every card capability fails closed — no local toggle / template
   * fallback is used.
   */
  available: boolean;
  /** Legacy manifest master switch; real sends use the server-ANDed `config` values. */
  enabled: boolean;
  /** Supported profile list, e.g. `["octo/v1"]` (P2 adds `"octo/v2"`). */
  profiles?: string[];
  card_version?: string;
  /** Server-advertised element / input whitelist (pkg/cardmsg authoritative, additive). */
  elements?: string[];
  inputs?: string[];
  /**
   * Local / navigation action whitelist. `Action.Submit` is NOT listed here — it
   * is signalled by `profiles` containing `octo/v2`. Old deployments omit this
   * (undefined) → consumers conservatively treat all actions as unsupported.
   */
  actions?: string[];
  /** Size / structure limits (node/depth/body caps, etc.). */
  limits?: Record<string, unknown>;
  /** Optional Registry template-ref/v1 capability and explicit Bot catalog. */
  templating?: CardTemplatingCapability;
  /** Effective per-bot policy. Each flag already includes the server's global gate. */
  config?: BotCardConfig;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseTemplatingCapability(value: unknown): CardTemplatingCapability | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const templates: CardTemplateCapability[] = [];
  for (const candidate of Array.isArray(root.templates) ? root.templates : []) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const template = candidate as Record<string, unknown>;
    if (typeof template.id !== "string" || typeof template.version !== "string") continue;
    const views: CardTemplateViewCapability[] = [];
    for (const candidateView of Array.isArray(template.views) ? template.views : []) {
      if (!candidateView || typeof candidateView !== "object" || Array.isArray(candidateView)) continue;
      const view = candidateView as Record<string, unknown>;
      if (typeof view.name !== "string" || typeof view.wire_profile !== "string") continue;
      views.push({
        name: view.name,
        wire_profile: view.wire_profile,
        states: stringArray(view.states),
        submit_actions: stringArray(view.submit_actions),
      });
    }
    templates.push({ id: template.id, version: template.version, views });
  }
  return {
    supported: root.supported === true,
    wire: typeof root.wire === "string" ? root.wire : "",
    templates,
  };
}

function parseCardTemplateRef(value: unknown): CardTemplateRef | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = value as Record<string, unknown>;
  if (Object.keys(ref).length !== 2 ||
      typeof ref.id !== "string" || !ref.id || ref.id.trim() !== ref.id ||
      typeof ref.version !== "string" || !ref.version || ref.version.trim() !== ref.version) {
    return undefined;
  }
  return { id: ref.id, version: ref.version };
}

function parseBotCardConfig(value: unknown): BotCardConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const config = value as Record<string, unknown>;
  if (typeof config.card_enabled !== "boolean" ||
      typeof config.display_enabled !== "boolean" ||
      typeof config.interaction_enabled !== "boolean" ||
      typeof config.reasoning_enabled !== "boolean") {
    return undefined;
  }
  if (!config.card_enabled &&
      (config.display_enabled || config.interaction_enabled || config.reasoning_enabled)) {
    return undefined;
  }
  const reasoningRef = parseCardTemplateRef(config.reasoning_template_ref);
  // The server guarantees this invariant. Reject a malformed response rather than guessing a
  // policy locally: a permissive normalization could re-enable a card the Bot owner disabled.
  if (reasoningRef === undefined ||
      (config.reasoning_enabled && reasoningRef === null) ||
      (!config.reasoning_enabled && reasoningRef !== null)) {
    return undefined;
  }
  return {
    card_enabled: config.card_enabled,
    display_enabled: config.display_enabled,
    interaction_enabled: config.interaction_enabled,
    reasoning_enabled: config.reasoning_enabled,
    reasoning_template_ref: reasoningRef,
  };
}

/**
 * GET /v1/bot/card/profile — D12 capability discovery. Feature-detect before
 * sending a card instead of probing with a send (a 400 cannot distinguish
 * "disabled" from "invalid").
 *
 * FAIL-CLOSED: the caller must degrade on every non-success outcome.
 *   - endpoint not deployed (404) → `{ available: false, enabled: false }`.
 *   - deployed but body missing / malformed → `{ available: true, enabled: false }`
 *     (and any malformed `config` / `templating` is simply dropped).
 * Transport / 5xx throws, leaving the retry cadence to the caller.
 */
export async function getCardProfile(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<CardProfileManifest> {
  const path = "/v1/bot/card/profile";
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  // Endpoint not yet deployed → fail closed; never guess the server's Bot policy locally.
  if (resp.status === 404) return { available: false, enabled: false };
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  // Endpoint deployed (available:true); a malformed manifest degrades to enabled:false.
  const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return { available: true, enabled: false };
  const templating = parseTemplatingCapability(raw.templating);
  const config = parseBotCardConfig(raw.config);
  return {
    available: true,
    // Accept boolean and 1/0 serialization (consistent with GroupMember.robot / getMentionPref).
    enabled: raw.enabled === true || raw.enabled === 1,
    ...(Array.isArray(raw.profiles) ? { profiles: stringArray(raw.profiles) } : {}),
    ...(typeof raw.card_version === "string" ? { card_version: raw.card_version } : {}),
    ...(Array.isArray(raw.elements) ? { elements: stringArray(raw.elements) } : {}),
    ...(Array.isArray(raw.inputs) ? { inputs: stringArray(raw.inputs) } : {}),
    ...(Array.isArray(raw.actions) ? { actions: stringArray(raw.actions) } : {}),
    ...(raw.limits && typeof raw.limits === "object" ? { limits: raw.limits as Record<string, unknown> } : {}),
    ...(templating ? { templating } : {}),
    ...(config ? { config } : {}),
  };
}

const ACTION_SUBMIT = "Action.Submit";

function positiveFiniteLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

/** Convert the server manifest into one authoritative set of renderer capabilities. */
export function deriveCardCaps(manifest: CardProfileManifest): CardCaps {
  const limits = manifest.limits;
  const maxNodes = positiveFiniteLimit(limits?.max_nodes);
  const maxDepth = positiveFiniteLimit(limits?.max_depth);
  const maxPayloadBytes = positiveFiniteLimit(limits?.max_payload_bytes);
  const maxInputTextBytes = positiveFiniteLimit(limits?.max_input_text_bytes);
  const maxInputsBytes = positiveFiniteLimit(limits?.max_inputs_bytes);

  return {
    ...(Array.isArray(manifest.elements) ? { elements: new Set(manifest.elements) } : {}),
    ...(Array.isArray(manifest.inputs) ? { inputs: new Set(manifest.inputs) } : {}),
    ...(Array.isArray(manifest.actions) ? { actions: new Set(manifest.actions) } : {}),
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(maxPayloadBytes !== undefined ? { maxPayloadBytes } : {}),
    ...(maxInputTextBytes !== undefined ? { maxInputTextBytes } : {}),
    ...(maxInputsBytes !== undefined ? { maxInputsBytes } : {}),
  };
}

/**
 * D12 reserves `actions` for local/navigation actions. Submit-callback support is
 * advertised by the `octo/v2` profile itself, so translate that profile into the
 * builder's semantic capability rather than trusting a stray `Action.Submit` in
 * the actions list.
 */
export function deriveInteractiveCardCaps(manifest: CardProfileManifest): CardCaps {
  const caps = deriveCardCaps(manifest);
  const actions = new Set(caps.actions ?? []);
  actions.delete(ACTION_SUBMIT);
  if (manifest.profiles?.includes(CARD_INTERACTIVE_PROFILE)) actions.add(ACTION_SUBMIT);
  return { ...caps, actions };
}

// ─── Bot Events (card-action callback queue, A5) ─────────────────────────────

/** Bound on an *idle* /v1/bot/events request (short poll or ack). */
const EVENTS_POLL_TIMEOUT_MS = 10_000;
/** Slack added on top of a long-poll hold before the client gives up. */
const EVENTS_POLL_WAIT_MARGIN_MS = 10_000;
/** Mirrors the server-side clamp on `wait`. Single source of truth. */
export const MAX_EVENT_WAIT_SECONDS = 30;
/** Smallest useful hold; a non-zero value under this is raised to it rather than rejected. */
export const MIN_EVENT_WAIT_SECONDS = 5;

/**
 * Client timeout for one /v1/bot/events request. Must exceed the requested hold,
 * otherwise the client aborts mid-hold and the poll loop degrades into a
 * timeout/retry storm strictly worse than plain short polling.
 */
export function eventsPollTimeoutMs(waitSeconds?: number): number {
  if (!waitSeconds || waitSeconds <= 0) return EVENTS_POLL_TIMEOUT_MS;
  return waitSeconds * 1000 + EVENTS_POLL_WAIT_MARGIN_MS;
}

/**
 * Pull typed bot events strictly after the supplied cursor.
 *
 * With `waitSeconds` unset or 0 this is a plain short poll. With `waitSeconds > 0`
 * the server holds an empty queue open for that long and answers as soon as an
 * event lands (opt-in on the wire, so a client that does not raise its own
 * timeout keeps working unchanged). An expired hold is a normal empty batch.
 */
export async function fetchBotEvents(params: {
  apiUrl: string;
  botToken: string;
  sinceEventId?: number;
  limit?: number;
  waitSeconds?: number;
  signal?: AbortSignal;
}): Promise<BotEvent[]> {
  const waitSeconds =
    params.waitSeconds && params.waitSeconds > 0
      ? Math.min(MAX_EVENT_WAIT_SECONDS, Math.floor(params.waitSeconds))
      : 0;
  const response = await postJson<{ results?: BotEvent[] }>(
    params.apiUrl,
    params.botToken,
    "/v1/bot/events",
    {
      event_id: params.sinceEventId ?? 0,
      limit: Math.max(1, Math.min(100, Math.floor(params.limit ?? 20))),
      // Omitted entirely when not long-polling, so the request stays byte-identical to what
      // servers that predate the `wait` field already accept.
      ...(waitSeconds > 0 ? { wait: waitSeconds } : {}),
    },
    params.signal ?? AbortSignal.timeout(eventsPollTimeoutMs(waitSeconds)),
    // The poll loop paces itself between requests; a 429 here just returns and comes
    // around again, so it opts out of holding the loop through the shared backoff.
    { retryOn429: false },
  );
  return Array.isArray(response?.results) ? response.results : [];
}

/** Best-effort queue pruning after a recognized bot event has been accepted locally. */
export async function ackBotEvent(params: {
  apiUrl: string;
  botToken: string;
  eventId: number;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(
    params.apiUrl,
    params.botToken,
    `/v1/bot/events/${params.eventId}/ack`,
    {},
    params.signal ?? AbortSignal.timeout(EVENTS_POLL_TIMEOUT_MS),
    // Best-effort queue pruning; a missed ack is harmless and re-attempted on the next
    // recognized event, so it does not hold the caller through the 429 backoff.
    { retryOn429: false },
  );
}

// ─── Mention Preference (per-group @-免 gate) ────────────────────────────────

/** Short timeout for the per-message mention_pref hot-path lookup. */
const MENTION_PREF_TIMEOUT_MS = 3_000;

/**
 * Per-group mention preference (octo-server #237 / YUJ-2996). Two permission axes
 * AND together:
 *  - `no_mention`: the bot owner's intent (no record = false).
 *  - `group_allow_no_mention`: the group-level master switch (no record = true).
 *  - `effective = no_mention && group_allow_no_mention`: whether a mention-free
 *    message may trigger a reply. The gate reads only `effective`.
 */
export interface MentionPref {
  no_mention: boolean;
  group_allow_no_mention: boolean;
  effective: boolean;
}

/**
 * Fetch a group's mention preference for the current bot. Never throws: any
 * failure (network / non-2xx / parse) falls back to account-level behavior
 * (`effective=false`, i.e. mention still required) so the gate cannot crash.
 * Old servers that return only `{ no_mention }` degrade to `effective=no_mention`.
 */
export async function getMentionPref(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  signal?: AbortSignal;
}): Promise<MentionPref> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/mention_pref`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.botToken}` },
      signal: params.signal ?? AbortSignal.timeout(MENTION_PREF_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // 404 (endpoint not deployed yet) / 401 (empty token) are benign and recur on every
      // inbound message — do not spam error logs for the expected rollout statuses.
      if (resp.status !== 404 && resp.status !== 401) {
        console.error(`octo: getMentionPref(${params.groupNo}) failed: ${resp.status}`);
      }
      return { no_mention: false, group_allow_no_mention: true, effective: false };
    }
    const data = await resp.json() as Record<string, unknown>;
    // Accept boolean `true` or numeric `1` (DB/JSON may serialize either).
    const noMention = data?.no_mention === true || data?.no_mention === 1;
    const groupAllow = data?.group_allow_no_mention === undefined
      ? true
      : data.group_allow_no_mention === true || data.group_allow_no_mention === 1;
    const effective = data?.effective === undefined
      ? noMention && groupAllow
      : data.effective === true || data.effective === 1;
    return { no_mention: noMention, group_allow_no_mention: groupAllow, effective };
  } catch (err) {
    console.error(`octo: getMentionPref(${params.groupNo}) error: ${String(err)}`);
    return { no_mention: false, group_allow_no_mention: true, effective: false };
  }
}

// ─── OBO Grant (persona-clone introspection) ─────────────────────────────────

/**
 * The bot's view of its own OBO grant (GET /v1/bot/obo-grant, octo-server
 * YUJ-1762). A persona clone reads the active `persona_prompt` from here; a
 * regular bot has no grant.
 */
export interface BotOboGrant {
  /** False / absent when the bot has no active grant (regular non-persona bot). */
  has_grant: boolean;
  grantor_uid?: string;
  grantor_name?: string;
  persona_prompt?: string;
  /** Whether the grant is currently active (mode != "paused" & not revoked). */
  active?: boolean;
}

/**
 * GET /v1/bot/obo-grant — fetch this bot's own OBO grant info.
 *
 * Returns null when the bot has no grant (404), the server reports
 * has_grant=false, or the response is malformed. Throws on transport / 5xx so
 * the caller's retry-on-next-tick cadence can decide whether to log and skip.
 */
export async function getBotOboGrant(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<BotOboGrant | null> {
  const path = "/v1/bot/obo-grant";
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  // 404 = no grant for this bot (regular bot, not a persona clone).
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return null;
  // Accept when `has_grant: true` is explicit, OR when the field is absent and a
  // non-empty `grantor_uid` is present (some server versions omit has_grant). An
  // explicit `has_grant: false` is authoritative denial and fails closed.
  const hasGrant = raw.has_grant === true ||
    (raw.has_grant === undefined &&
      typeof raw.grantor_uid === "string" &&
      raw.grantor_uid.length > 0);
  if (!hasGrant) return null;
  return {
    has_grant: true,
    grantor_uid: typeof raw.grantor_uid === "string" ? raw.grantor_uid : undefined,
    grantor_name: typeof raw.grantor_name === "string" ? raw.grantor_name : undefined,
    persona_prompt: typeof raw.persona_prompt === "string" ? raw.persona_prompt : undefined,
    active: raw.active === true,
  };
}

// ─── Presigned Upload (backend-agnostic file upload) ─────────────────────────

/**
 * Get a presigned PUT URL for direct, backend-agnostic file upload
 * (GET /v1/bot/upload/presigned). Signs a PUT URL against whatever object
 * storage the deployment uses (MinIO / COS / S3 / OSS).
 *
 * `fileSize` is REQUIRED and must be the exact byte count of the body about to
 * be PUT: on SigV4 backends it is signed into the canonical headers as
 * Content-Length, so any mismatch returns 403 SignatureDoesNotMatch.
 */
export async function getUploadPresign(params: {
  apiUrl: string;
  botToken: string;
  filename: string;
  fileSize: number;
  contentType?: string;
  signal?: AbortSignal;
}): Promise<{
  uploadUrl: string;
  downloadUrl: string;
  contentType: string;
  contentDisposition?: string;
}> {
  if (!Number.isInteger(params.fileSize) || params.fileSize <= 0) {
    throw new Error(`getUploadPresign requires a positive integer fileSize (got ${params.fileSize})`);
  }
  const query = new URLSearchParams({
    filename: params.filename,
    fileSize: String(params.fileSize),
  });
  if (params.contentType) query.set("contentType", params.contentType);
  const path = "/v1/bot/upload/presigned";
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}?${query}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${response.status}): ${text || response.statusText}`);
  }
  const data = await response.json() as Record<string, unknown>;
  if (typeof data.uploadUrl !== "string" || typeof data.downloadUrl !== "string") {
    const missing = ["uploadUrl", "downloadUrl"].filter((k) => typeof data[k] !== "string");
    throw new Error(`Octo API ${path} returned incomplete response: missing ${missing.join(", ")}`);
  }
  return {
    uploadUrl: data.uploadUrl,
    downloadUrl: data.downloadUrl,
    contentType: typeof data.contentType === "string" ? data.contentType : "application/octet-stream",
    contentDisposition: typeof data.contentDisposition === "string" ? data.contentDisposition : undefined,
  };
}

/**
 * Upload a file body with a single PUT to a server-issued presigned URL. The
 * body must be exactly `fileSize` bytes (the same value passed to
 * {@link getUploadPresign} so the signed Content-Length matches). `contentType`
 * and `contentDisposition` are replayed verbatim from the presign response —
 * both are folded into the canonical headers on MinIO/COS, so omitting or
 * altering them returns 403 SignatureDoesNotMatch.
 *
 * Returns `{ url }` = the presign response's `downloadUrl`.
 */
export async function uploadFileToPresignedUrl(params: {
  uploadUrl: string;
  downloadUrl: string;
  fileBody: Buffer | NodeJS.ReadableStream;
  fileSize: number;
  contentType: string;
  contentDisposition?: string;
  signal?: AbortSignal;
}): Promise<{ url: string }> {
  const headers: Record<string, string> = {
    "Content-Type": params.contentType,
    "Content-Length": String(params.fileSize),
  };
  if (params.contentDisposition) {
    headers["Content-Disposition"] = params.contentDisposition;
  }
  // `duplex: "half"` is required by undici when streaming a request body but is
  // not yet in the RequestInit typings; intersect it in rather than casting to any.
  const init: RequestInit & { duplex: "half" } = {
    method: "PUT",
    headers,
    body: params.fileBody as unknown as RequestInit["body"],
    duplex: "half",
    signal: params.signal,
  };
  const response = await fetch(params.uploadUrl, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Presigned PUT upload failed (${response.status}): ${text || response.statusText}`);
  }
  return { url: params.downloadUrl };
}

// ─── Target Resolve (name → channel candidates) ──────────────────────────────

/**
 * Resolve a NAMED target ("forward to 'XXX'") into concrete channel candidates
 * (GET /v1/bot/resolve/targets, octo-server PR #337). Returns candidates the
 * caller must disambiguate against — it must NEVER hand-build a `group:` address
 * from a name. An empty result (App Bot, or no match) is candidates:[] / total:0
 * with HTTP 200, not an error. The response is snake_case and mapped explicitly
 * into the camelCase TargetCandidate shape so a backend field rename surfaces as
 * a typed gap here rather than propagating silently.
 */
export async function resolveTargetsByName(params: {
  apiUrl: string;
  botToken: string;
  name: string;
  kind?: "group" | "thread" | "all";
  limit?: number;
  signal?: AbortSignal;
}): Promise<{ candidates: TargetCandidate[]; total: number; truncated: boolean }> {
  const query = new URLSearchParams();
  query.set("name", params.name);
  if (params.kind) query.set("kind", params.kind);
  if (params.limit != null) query.set("limit", String(params.limit));
  const path = "/v1/bot/resolve/targets";
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}?${query}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  const data = (await resp.json()) as {
    candidates?: Array<Record<string, unknown>>;
    total?: number;
    truncated?: boolean;
  };
  const rawCandidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const candidates: TargetCandidate[] = rawCandidates.map((c) => {
    const mapped: TargetCandidate = {
      kind: c.kind as "group" | "thread",
      channelId: c.channel_id as string,
      channelType: c.channel_type as ChannelType,
      name: c.name as string,
      groupNo: c.group_no as string,
    };
    if (c.short_id != null) mapped.shortId = c.short_id as string;
    if (c.parent_name != null) mapped.parentName = c.parent_name as string;
    return mapped;
  });
  // When the server omits `total`, fall back to candidates.length — but that fallback is
  // unsafe if we asked for a bounded page (limit) and got a full page back: total would
  // collapse to the page size and a truncated result could masquerade as genuinely unique.
  // Fail closed: if total is missing AND we hit the limit, force truncated=true.
  const hasTotal = typeof data?.total === "number";
  const total = hasTotal ? (data.total as number) : candidates.length;
  const limitReached =
    typeof params.limit === "number" && params.limit > 0 && candidates.length >= params.limit;
  const truncated = data?.truncated === true || (!hasTotal && limitReached);
  return { candidates, total, truncated };
}

// ─── Bot Group Management ─────────────────────────────────────────────────────

export async function createGroup(params: {
  apiUrl: string;
  botToken: string;
  name?: string;
  members: string[];
  creator: string;
  spaceId?: string;
  signal?: AbortSignal;
}): Promise<{ group_no: string; name: string }> {
  const path = "/v1/bot/createGroup";
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify({
      name: params.name,
      members: params.members,
      creator: params.creator,
      ...(params.spaceId ? { space_id: params.spaceId } : {}),
    }),
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { group_no: string; name: string };
}

export async function updateGroup(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  name?: string;
  notice?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const body: Record<string, string> = {};
  if (params.name != null) body.name = params.name;
  if (params.notice != null) body.notice = params.notice;
  const path = `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/info`;
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify(body),
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
}

export async function addGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  members: string[];
  signal?: AbortSignal;
}): Promise<{ ok: boolean; added: number }> {
  const path = `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/members/add`;
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify({ members: params.members }),
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { ok: boolean; added: number };
}

export async function removeGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  members: string[];
  signal?: AbortSignal;
}): Promise<{ ok: boolean; removed: number }> {
  const path = `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/members/remove`;
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify({ members: params.members }),
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { ok: boolean; removed: number };
}

// ─── Bot Groups List / Group Info ─────────────────────────────────────────────

/**
 * Fetch the groups the bot belongs to (GET /v1/bot/groups). Best-effort: returns
 * `[]` on any non-2xx or transport error so callers can degrade.
 */
export async function fetchBotGroups(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<Array<{ group_no: string; name: string }>> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.botToken}` },
      signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.error(`octo: fetchBotGroups failed: ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    return Array.isArray(data) ? data as Array<{ group_no: string; name: string }> : [];
  } catch (err) {
    console.error(`octo: fetchBotGroups error: ${String(err)}`);
    return [];
  }
}

/** Fetch a group's info (GET /v1/bot/groups/{groupNo}). Throws on non-2xx. */
export async function getGroupInfo(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  signal?: AbortSignal;
}): Promise<{ group_no: string; name: string; [key: string]: unknown }> {
  return await getJson<{ group_no: string; name: string; [key: string]: unknown }>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}`,
    params.signal,
  );
}

// ─── Space Members ────────────────────────────────────────────────────────────

export async function searchSpaceMembers(params: {
  apiUrl: string;
  botToken: string;
  keyword?: string;
  spaceId?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<Array<{ uid: string; name: string; robot: number }>> {
  const query = new URLSearchParams();
  if (params.keyword) query.set("keyword", params.keyword);
  if (params.spaceId) query.set("space_id", params.spaceId);
  if (params.limit) query.set("limit", String(params.limit));
  const path = "/v1/bot/space/members";
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}?${query}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as Array<{ uid: string; name: string; robot: number }>;
}

// ─── Voice Context CRUD (owner's personal voice-correction context) ───────────

/**
 * Generic helper for bot JSON API requests (GET / PUT / DELETE). Centralizes URL
 * construction, auth headers, timeout, and error handling; a body implies a JSON
 * Content-Type. GET returns the parsed JSON, PUT/DELETE resolve to void.
 */
async function botFetchJson<T = void>(params: {
  apiUrl: string;
  botToken: string;
  path: string;
  method: "GET" | "PUT" | "DELETE";
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<T> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}${params.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.botToken}`,
  };
  if (params.body) {
    Object.assign(headers, DEFAULT_HEADERS);
  }
  const resp = await fetch(url, {
    method: params.method,
    headers,
    body: params.body ? JSON.stringify(params.body) : undefined,
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${params.method} ${params.path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  if (params.method === "GET") {
    return (await resp.json()) as T;
  }
  return undefined as T;
}

/**
 * Query the owner's personal voice-correction context (GET /v1/bot/voice/context).
 * Normalizes defensively: has_context defaults to false, context / updated_at to
 * empty string if the backend omits them.
 */
export async function getVoiceContext(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<{ has_context: boolean; context: string; updated_at: string }> {
  const raw = await botFetchJson<Record<string, unknown>>({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    path: "/v1/bot/voice/context",
    method: "GET",
    signal: params.signal,
  });
  return {
    has_context: raw.has_context === true,
    context: typeof raw.context === "string" ? raw.context : "",
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
  };
}

/**
 * Set the owner's personal voice-correction context (PUT upsert). Content must
 * not be empty — that is enforced by callers and by the backend (400 on empty).
 */
export async function updateVoiceContext(params: {
  apiUrl: string;
  botToken: string;
  content: string;
  signal?: AbortSignal;
}): Promise<void> {
  await botFetchJson({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    path: "/v1/bot/voice/context",
    method: "PUT",
    body: { context: params.content },
    signal: params.signal,
  });
}

/** Delete the owner's personal voice-correction context (idempotent; DELETE). */
export async function deleteVoiceContext(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<void> {
  await botFetchJson({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    path: "/v1/bot/voice/context",
    method: "DELETE",
    signal: params.signal,
  });
}

// ─── Secret Resolve (user-managed external keys) ──────────────────────────────

/**
 * One candidate when an alias matches more than one stored secret.
 *
 * 🔴 SECURITY: candidates carry ONLY non-sensitive identifiers (display_name +
 * secret_id). The plaintext secret value is NEVER part of a candidate.
 */
export interface SecretCandidate {
  /** Stable opaque id of the secret (safe to echo back for re-resolution). */
  secret_id?: string;
  /** Human-facing label the owner gave the secret. Safe to show. */
  display_name: string;
}

/**
 * Result of resolving a secret alias for the bot's owner. Discriminated on
 * `status`:
 *  - `resolved`     → exactly one EXACT match; `value` holds the plaintext.
 *  - `not_found`    → no secret matches the alias (also covers "endpoint not
 *                     deployed yet during rollout").
 *  - `ambiguous`    → needs confirmation; `candidates` lists labels only.
 *  - `rate_limited` → the per-IP resolve limiter rejected this call (HTTP 429).
 *
 * 🔴 RED LINE: the `value` field on the `resolved` variant is the ONLY place
 * plaintext appears. Callers must consume it internally and MUST NOT propagate it
 * into any LLM-visible return value, transcript, message, or log.
 */
export type ResolveSecretResult =
  | { status: "resolved"; value: string; secret_id?: string; display_name?: string }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: SecretCandidate[] }
  | { status: "rate_limited" };

/**
 * Map a raw candidate array into label-only SecretCandidate entries.
 *
 * 🔴 SECURITY: deliberately copies ONLY `display_name` + `secret_id` — never any
 * `value`/`masked`/other server field. Entries with no label are dropped.
 */
function parseCandidates(rawCandidates: unknown[]): SecretCandidate[] {
  return rawCandidates
    .map((c) => {
      const obj = (c ?? {}) as Record<string, unknown>;
      const displayName = typeof obj.display_name === "string" ? obj.display_name : "";
      const secretId = typeof obj.secret_id === "string" ? obj.secret_id : undefined;
      return { display_name: displayName, secret_id: secretId };
    })
    .filter((c) => c.display_name.length > 0);
}

/**
 * Resolve a user-managed external-key alias to its current plaintext value
 * (POST /v1/bot/secrets/resolve, octo-server YUJ-3538 / PR#301). The wire field
 * is `query` (accepts a display_name or a secret_id); the server authenticates
 * the bot and resolves against the secrets owned by that bot's owner.
 *
 * HTTP status is authoritative: 200 `{ secret_id?, value }` = resolved; 404 =
 * not_found; 422 = ambiguous (masked candidates at `error.details.candidates`);
 * 429 = rate_limited; any other non-2xx throws. A legacy 200 body still carrying
 * an explicit `status` discriminator is honored for backward compatibility.
 *
 * 🔴 SECURITY: on a thrown non-2xx the Error message contains ONLY the HTTP
 * status — never the response body and never a resolved value.
 */
export async function resolveSecret(params: {
  apiUrl: string;
  botToken: string;
  /** Alias the owner referenced: a display_name or a secret_id. */
  alias: string;
  signal?: AbortSignal;
}): Promise<ResolveSecretResult> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/secrets/resolve`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    // The server binds the request field `query` and 400s when empty.
    body: JSON.stringify({ query: params.alias }),
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  // 404 = alias not found (or endpoint not deployed yet) → benign not_found.
  if (resp.status === 404) return { status: "not_found" };

  // 422 = ambiguous: masked candidate list at error.details.candidates. Reading
  // THIS body is safe (masked identifiers only); no other error body is read.
  if (resp.status === 422) {
    const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    const error = (raw?.error ?? {}) as Record<string, unknown>;
    const details = (error.details ?? {}) as Record<string, unknown>;
    const rawCandidates = Array.isArray(details.candidates) ? details.candidates : [];
    return { status: "ambiguous", candidates: parseCandidates(rawCandidates) };
  }

  // 429 = per-IP resolve limiter rejected this call. Do NOT read the body.
  if (resp.status === 429) return { status: "rate_limited" };

  if (!resp.ok) {
    // 🔴 SECURITY: never fold the response body into the error — a resolve
    // endpoint handles plaintext secrets and this error reaches an LLM-visible
    // tool result, so it must carry the HTTP status ONLY.
    throw new Error(`resolveSecret failed (${resp.status})`);
  }

  const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    throw new Error("resolveSecret returned an unparseable response");
  }

  const status = raw.status;

  // Backward-compat: honor a legacy 200 body that still carries an explicit status.
  if (status === "not_found") return { status: "not_found" };
  if (status === "ambiguous") {
    const rawCandidates = Array.isArray(raw.candidates) ? raw.candidates : [];
    return { status: "ambiguous", candidates: parseCandidates(rawCandidates) };
  }

  // Resolved: current server returns 200 `{ secret_id?, value }` WITHOUT a status
  // field, so a 200 carrying a non-empty `value` is resolved. Legacy
  // `status:"resolved"` is also accepted.
  if (status === "resolved" || (status === undefined && "value" in raw)) {
    if (typeof raw.value !== "string" || raw.value.length === 0) {
      throw new Error("resolveSecret resolved a secret with no value");
    }
    return {
      status: "resolved",
      value: raw.value,
      secret_id: typeof raw.secret_id === "string" ? raw.secret_id : undefined,
      display_name: typeof raw.display_name === "string" ? raw.display_name : undefined,
    };
  }

  // 🔴 SECURITY: never fold the server-supplied status string into the error.
  throw new Error("resolveSecret returned an unknown status");
}

// ─── Doc Comment / HTML Doc Reply (docs domain, not IM) ───────────────────────

/**
 * Turn a decimal integer string into a value `JSON.stringify` writes verbatim as
 * a JSON *number*, with full precision preserved (via JSON.rawJSON).
 *
 * Docs comment ids are snowflakes (> 2^53). Routing one through `Number()` would
 * silently land on an adjacent integer — the reply would attach to a DIFFERENT
 * real comment. A quoted string is rejected by the number-typed server field.
 * When the value cannot be represented losslessly this returns `undefined` (the
 * caller then omits parentId and posts a root comment) rather than degrading to a
 * lossy `Number()`.
 */
export function jsonNumberLiteral(decimal: string): unknown | undefined {
  if (!/^[1-9]\d*$/.test(decimal)) return undefined;
  const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
  if (typeof rawJSON === "function") return rawJSON(decimal);
  const asNumber = Number(decimal);
  return Number.isSafeInteger(asNumber) ? asNumber : undefined;
}

/** Matches the `failed (<status>)` fragment in this module's thrown error messages. */
export const API_FETCH_STATUS_RE = /failed \((\d{3})\)/;

/**
 * Extract the HTTP status from an api.ts error. The fetch helpers here throw
 * `Error("Octo API ... failed (<status>): ...")` on non-2xx, so the status is
 * recoverable from the message. Returns undefined for errors without an embedded
 * `(NNN)` (e.g. a network timeout).
 */
export function httpStatusFromApiFetchError(err: unknown): number | undefined {
  // OctoApiError carries the status as a field. The regex stays for the errors this
  // module still throws as plain Errors (getJson/requestNoBody wrappers, invalid-JSON).
  if (err instanceof OctoApiError) return err.status;
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(API_FETCH_STATUS_RE);
  return match ? Number(match[1]) : undefined;
}

/** The docs backend explicitly rejected this comment (2xx but a failure envelope). */
export class DocCommentRejectedError extends Error {
  readonly name = "DocCommentRejectedError";
}

/**
 * Does retrying this doc-comment error stand a chance of succeeding? An envelope
 * rejection is deterministic. So are most 4xx — except 408 / 423 / 425 / 429,
 * which carry "come back later" semantics. Network / 5xx / timeout are retriable.
 */
export function isPermanentDocCommentFailure(err: unknown): boolean {
  if (err instanceof DocCommentRejectedError) return true;
  const status = httpStatusFromApiFetchError(err);
  if (status === undefined) return false;
  if (status === 408 || status === 423 || status === 425 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * Post a Bot comment under a document's comment thread (docs domain, unrelated to
 * IM messages). `parentId` (a decimal snowflake string) is written losslessly via
 * jsonNumberLiteral; when it cannot be represented the field is omitted and the
 * comment is posted at the root rather than mis-attached.
 *
 * The platform returns a `{status, ...}` envelope: a business failure (doc gone,
 * no permission, body too long) can still be HTTP 200. Since this POST is the
 * only delivery receipt for the feature, we assert the SUCCESS shape
 * (status === 1 / "1") and throw a DocCommentRejectedError otherwise — but a
 * response with NO `status` field is treated per HTTP semantics (resolve), since
 * the docs backend need not use the same envelope.
 */
export async function postDocComment(params: {
  apiUrl: string;
  botToken: string;
  docId: string;
  /** Comment-thread root id, a DECIMAL STRING (snowflake, kept off the JS number path). */
  parentId?: string;
  body: string;
  signal?: AbortSignal;
}): Promise<void> {
  const path = `/v1/bot/docs/${encodeURIComponent(params.docId)}/comments`;
  const parentLiteral =
    params.parentId !== undefined ? jsonNumberLiteral(params.parentId) : undefined;
  const result = await postJson<{ status?: unknown; msg?: unknown; message?: unknown }>(
    params.apiUrl,
    params.botToken,
    path,
    {
      body: params.body,
      ...(parentLiteral !== undefined ? { parentId: parentLiteral } : {}),
    },
    params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  );

  if (result && typeof result === "object" && !Array.isArray(result) && "status" in result) {
    const { status } = result;
    const ok = status === 1 || status === "1";
    if (!ok) {
      const detail = result.msg ?? result.message;
      const detailText =
        detail && typeof detail === "object" ? JSON.stringify(detail) : String(detail);
      throw new DocCommentRejectedError(
        `Octo API ${path} rejected the comment (status=${String(status)})${detail ? `: ${detailText}` : ""}`,
      );
    }
  }
}

/**
 * Doc-comment reply intent (closed set). `final` and `progress` MUST stay
 * distinct: a `progress` frame is a mid-state and must not flip the parent
 * comment to resolved.
 *   - `final`    → `applied`
 *   - `progress` → `partial`
 *   - `notice`   → `question` (failure / timeout / fallback; never touched the doc)
 */
export type DocReplyIntent = "final" | "progress" | "notice";

/** intent → comment status marker. Defaults conservatively to `applied`. */
export function docReplyStatusOf(intent?: DocReplyIntent): string {
  if (intent === "notice") return "question";
  if (intent === "progress") return "partial";
  return "applied";
}

/**
 * Post a Bot reply under an HTML document (octo-doc) comment thread.
 *
 * This is NOT postDocComment: that hits `/v1/bot/docs/<docId>/comments` keyed by
 * docId; an HTML doc is identified by an octo-doc slug the docs-backend cannot
 * resolve. HTML comments live in octo-doc and go through its own agent-reply path
 * under the `/docs-html` prefix (reverse-proxied to octo-doc in production).
 */
export async function postHtmlDocReply(params: {
  apiUrl: string;
  botToken: string;
  slug: string;
  parentId: string;
  body: string;
  /** See DocReplyIntent. Defaults to applied (preserves the prior contract). */
  intent?: DocReplyIntent;
  signal?: AbortSignal;
}): Promise<void> {
  const path = `/docs-html/v1/agent/replies`;
  await postJson(
    params.apiUrl,
    params.botToken,
    path,
    {
      slug: params.slug,
      parent_id: params.parentId,
      text: params.body,
      status: docReplyStatusOf(params.intent),
    },
    params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  );
  // No {status:1} envelope check: octo-doc returns {data}/{error}; a business
  // failure is a non-2xx already thrown by postJson.
}
