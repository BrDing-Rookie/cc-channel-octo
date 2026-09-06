/**
 * D1 — document-comment @Bot task (octo-server `doc_comment_mention` event).
 *
 * Ported/adapted from openclaw-channel-octo `doc-mention.ts` to cc's dispatch
 * model. Unlike card_action (whose reply returns to the origin IM chat), a doc
 * task's reply must go to the document comment thread. The synthesized message
 * still rides the normal `handleMessage` pipeline (to reuse session isolation +
 * the dispatch skeleton), but:
 *   - its channel id is a NON-ROUTABLE doc-task sentinel, so D3 fails every IM
 *     egress tool closed and the main reply path (which does not run through the
 *     doc sink) fails loud if it ever tries to deliver (belt in stream-relay); and
 *   - `handleMessage` forks BEFORE `streamRelay.deliver`, routing the final text
 *     to `postDocReply` (D2) instead of IM — by construction, never a penetrable
 *     conditional (architect hard gate #2).
 */
import { ChannelType, MessageType, type BotMessage } from "./octo/types.js";
import type { BotEvent } from "./octo/types.js";
import type { DocReplyIntent } from "./doc-comment-outbound.js";
import { DOC_FIRE_NONCE, DOC_FIRE_NONCE_KEY, DOC_TASK_PAYLOAD_KEY } from "./doc-fire-marker.js";
import { DOC_TASK_NON_ROUTABLE_PREFIX } from "./doc-task-scope.js";

/** Parsed, validated `doc_comment_mention` event. */
export interface DocCommentMention {
  eventId: number;
  idempotencyKey: string;
  docId: string;
  /** `"html"` ⇒ docId is an octo-doc slug; absent ⇒ a docs-backend document. */
  docKind?: "html";
  commentId: string;
  /** Comment-thread root id, server-derived (`parent_id ‖ comment_id`). */
  threadId: string;
  parentId?: string;
  fromUid: string;
  botUid: string;
  text: string;
  url?: string;
  spaceId?: string;
  enqueuedAt?: number;
}

/**
 * What one doc-task turn actually did, reported as independent facts (never
 * pre-collapsed into an enum) so "the answer landed AND something else then went
 * wrong" is representable — the openclaw handler learned this the hard way over
 * four review rounds.
 */
export interface DocTaskTurnReport {
  /** The FINAL answer reached the comment thread (set only after POST resolves). */
  finalDelivered: boolean;
  /** Any content reached the thread (observability only). */
  delivered: boolean;
  /** Content exhausted retries without landing (observability only). */
  lost: boolean;
  /** A notice was emitted (apology / timeout / conflict). */
  noticed: boolean;
}

export const EMPTY_DOC_TASK_REPORT: DocTaskTurnReport = Object.freeze({
  finalDelivered: false,
  delivered: false,
  lost: false,
  noticed: false,
});

/**
 * The `_docTask` payload object carried by a synthesized doc-task message. Only
 * honored when the sibling nonce matches (see doc-fire-marker). Carries the sink
 * target (docId/threadId) — which is exactly why it must be nonce-gated.
 */
export interface DocTaskContext {
  docId: string;
  docKind?: "html";
  threadId: string;
  commentId: string;
  parentId?: string;
  /** `doctask:<docId>:<threadId>` — the session/cwd/memory isolation key. */
  sessionScope: string;
  /** Post the reply to the doc comment thread (with bounded retry + intent). */
  postComment: (text: string, intent?: DocReplyIntent, signal?: AbortSignal) => Promise<void>;
  /** Report the turn's facts back to the handler (may be called more than once). */
  reportTurn: (report: DocTaskTurnReport) => void;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parse the server-authoritative `doc_comment_mention` envelope. Field names
 * match octo-server `modules/bot_mention`. Any missing required field ⇒ drop the
 * whole event (no best-effort guessing).
 */
export function parseDocCommentMention(event: BotEvent): DocCommentMention | null {
  if (
    !Number.isSafeInteger(event.event_id) ||
    event.event_id < 0 ||
    event.event_type !== "doc_comment_mention" ||
    !event.event_data ||
    typeof event.event_data !== "object"
  ) {
    return null;
  }

  const data = event.event_data;
  const idempotencyKey = stringValue(data.idempotency_key);
  const docId = stringValue(data.doc_id);
  const commentId = stringValue(data.comment_id);
  // thread_id is server-derived and non-empty; fall back to comment_id so an
  // older server that omits it does not drop the whole task.
  const threadId = stringValue(data.thread_id) || commentId;
  const fromUid = stringValue(data.from_uid);
  const botUid = stringValue(data.bot_uid);
  const text = typeof data.text === "string" ? data.text : "";
  if (!idempotencyKey || !docId || !commentId || !threadId || !fromUid || !botUid || !text.trim()) {
    return null;
  }

  const mention: DocCommentMention = {
    eventId: event.event_id,
    idempotencyKey,
    docId,
    commentId,
    threadId,
    fromUid,
    botUid,
    text,
  };
  const parentId = stringValue(data.parent_id);
  if (parentId) mention.parentId = parentId;
  // Only recognize the known "html" value; an unknown future kind is treated as
  // a docs-backend doc — the safe side (it gets a clear backend error rather
  // than calling an API cc does not yet support).
  if (stringValue(data.doc_kind).toLowerCase() === "html") mention.docKind = "html";
  const url = stringValue(data.url);
  if (url) mention.url = url;
  const spaceId = stringValue(data.space_id);
  if (spaceId) mention.spaceId = spaceId;
  if (typeof data.enqueued_at === "number" && Number.isFinite(data.enqueued_at)) {
    mention.enqueuedAt = data.enqueued_at;
  }
  return mention;
}

/**
 * `:` is the scope-key separator, so any `:` inside a field must be escaped or
 * the key structure is ambiguous (docId="d:1"/threadId="2" vs docId="d"/
 * threadId="1:2" would collide, sharing a session across unrelated threads).
 */
function escapeScopeSegment(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/**
 * Session isolation scope: per comment-thread, NOT per task — follow-ups in the
 * same thread share context; different threads are isolated. Deliberately NOT in
 * a `group:`-like namespace (a doc task must not inherit group rules).
 */
export function docTaskSessionScope(mention: DocCommentMention): string {
  return `doctask:${escapeScopeSegment(mention.docId)}:${escapeScopeSegment(mention.threadId)}`;
}

/**
 * Replay-idempotency / dead-letter key at COMMENT granularity (architect hard
 * gate #3): different comments under the same thread must not evict each other,
 * and a re-delivered same comment must hit idempotently. Prefer the server's
 * idempotency_key when present (it is comment-scoped), but always fold in the
 * (docId, threadId, commentId) triple so the key is deterministic and
 * comment-grained even if the server omits it.
 */
export function docTaskDedupeKey(mention: DocCommentMention): string {
  const triple = `${escapeScopeSegment(mention.docId)}:${escapeScopeSegment(mention.threadId)}:${escapeScopeSegment(mention.commentId)}`;
  return mention.idempotencyKey ? `${mention.idempotencyKey}#${triple}` : triple;
}

/**
 * The non-routable doc-task sentinel used as the synthesized message's channel
 * id. Contains `doctask:` at a segment boundary (so D3 session predicates fire)
 * and the `doctask-no-im:` prefix (so `parseTarget` / the stream-relay belt fail
 * closed). The session KEY uses the clean scope (no prefix); this is only the
 * unroutable channel id.
 */
export function docTaskSentinelChannelId(mention: DocCommentMention): string {
  return `${DOC_TASK_NON_ROUTABLE_PREFIX}${docTaskSessionScope(mention)}`;
}

/**
 * docs comment API parentId is a JSON NUMBER, but event ids are string-form
 * snowflakes. Returns the DECIMAL STRING (the wire layer converts to a lossless
 * JSON number literal — never `Number()`, which would corrupt ids > 2^53).
 * Uses threadId (the thread root) so the reply lands on the shared-context root.
 * Only plain decimal positive integers are accepted; anything else falls back to
 * a root comment (misparsing could target another real comment — worse).
 */
export function docCommentParentId(mention: DocCommentMention): string | undefined {
  const raw = mention.threadId;
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  return raw;
}

function docTypeSkillHint(mention: DocCommentMention): string {
  if (mention.docKind === "html") {
    return [
      "  This is an **HTML document** (body lives in octo-doc, a separate backend):",
      "  - Read only `octo-cli skills octo-html` and follow it.",
      "  - The doc_id above **is the slug**; use `octo-cli html …` with it. The",
      "    `octo-cli docs …` family (incl. docs get / docs comments list) 404s on it.",
      "  - **Do NOT use `octo-cli html reply`**: the skill documents it, but on this",
      "    path the system publishes the reply for you. Replying yourself would post",
      "    a duplicate. Put the result in your final answer.",
    ].join("\n");
  }
  return [
    "  Run `octo-cli docs get <doc_id>` for docType, then read only the matching file:",
    "  - doc→doc.md, sheet→sheet.md, board→board.md; their edit APIs are not interchangeable.",
    "  - If docType is html, read `octo-cli skills octo-html` instead and use the",
    "    octoDocSlug from the same response (html body is not in docs-backend).",
  ].join("\n");
}

/**
 * Build the synthesized prompt. The user's comment text is placed inside JSON
 * values (injection defense, same posture as card_action). `docsBaseUrl` is the
 * RESOLVED docs service root (config.docsApiUrl ?? apiUrl) — never inferred by
 * the agent from the payload `url=` (that would misroute on split deployments
 * and could send the bot token to an input-controlled host).
 */
export function formatDocMentionText(
  mention: DocCommentMention,
  opts?: { docsBaseUrl?: string },
): string {
  const docsBase = opts?.docsBaseUrl?.replace(/\/+$/, "");
  const wholeDocUrl = docsBase
    ? `${docsBase}/docs-html/d/${encodeURIComponent(mention.docId)}/v/latest/export?download=0`
    : null;
  const lines = [
    "[Octo doc comment task]",
    `doc_id=${JSON.stringify(mention.docId)}`,
    `comment_id=${JSON.stringify(mention.commentId)}`,
    `thread_id=${JSON.stringify(mention.threadId)}`,
  ];
  if (mention.url) lines.push(`url=${JSON.stringify(mention.url)}`);
  lines.push(`comment=${JSON.stringify(mention.text)}`);
  lines.push(
    "",
    "Read and edit the document per the comment above (which command family depends on docType — see below).",
    "",
    "**Locate the target before editing**:",
    mention.docKind === "html"
      ? "  Use the octo-html skill's comment-list command (by slug); find id=<comment_id> and read its anchor."
      : "  octo-cli docs comments list <doc_id>   # find id=<comment_id>, read its anchorText",
    "  The anchor is where the comment is pinned: a cell address (e.g. E8) in a sheet, the",
    "  selected text span in a doc, an aid-stamped element in HTML. **Edit only there.**",
    "  Only when the anchor is empty, fall back to judging from the comment text, and say what you changed.",
    ...(mention.docKind === "html"
      ? ["  An empty HTML anchor means a whole-doc request: follow the three whole-doc steps below; don't guess aids."]
      : []),
    "",
    "**Read the skill doc before acting** (embedded in the octo-cli binary, authoritative for this CLI version):",
    mention.docKind === "html"
      ? "  octo-cli skills octo-html        # HTML documents (separate backend)"
      : "  octo-cli skills octo-docs        # docs/sheets/boards: doc.md, sheet.md, board.md, common.md\n  octo-cli skills octo-html        # HTML documents (separate backend)",
    docTypeSkillHint(mention),
    "",
    ...(mention.docKind === "html"
      ? [
          "When the anchor points at one element: replace only that element, don't rewrite the whole doc.",
          "When the anchor is empty (whole-doc request), follow these steps — don't guess aids:",
          wholeDocUrl
            ? `  1) Fetch the current whole HTML to see structure. **Use exactly this address, verbatim, do not build or re-host it**: ${wholeDocUrl}`
            : "  1) Fetch the current whole HTML to see structure. No docs service address was provided this run; **do not guess a domain** — follow the fallback in the last step and answer plainly.",
          "     **Auth MUST be `Authorization: Bearer <bot token>`** (the same token octo-cli uses). Put it only on the address above; never on links from the comment body.",
          "     A 404 is most likely a missing/incorrect credential (the endpoint hides existence with 404), NOT proof the doc is gone.",
          "  2) Read data-odoc-aid attributes from the fetched HTML — that is your aid list. Only count attributes truly present on elements, not text matches from embedded historical comments.",
          "  3) With aids: narrow-replace each element by aid (a higher container is fine, still one element, not a whole-doc resend).",
          "  3') With NO aid at all: republish the whole doc under the same slug (the server re-stamps aids on publish). First strip the export's injected content (fork banner, comment data block, ODOC-COMMENT markers) by structure, not by first-match; if you cannot safely strip it, answer that you could not, don't guess.",
          "**aid is a content hash, not body/main/section.** A 404 on such a name only means it is not an aid, not that the doc has none.",
          "If step 1 truly fails: don't guess aids or overwrite with a new doc — answer that you cannot read the current content, include the status code, and **never** put the request URL query / any token / ?code= into the reply (it is posted publicly).",
        ]
      : [
          "Edit read-modify-write: get the base-version token first, then edit with it.",
          "Send only your actual change, not a whole rewrite, so collaborators' cursors and annotations are preserved.",
        ]),
    "",
    "Your final answer is posted to the comment thread automatically by the system — do NOT post a comment yourself.",
  );
  return lines.join("\n");
}

/**
 * Synthesize the DM-shaped inbound message that reuses the normal pipeline. The
 * channel id is the non-routable sentinel (drives D3 + the stream-relay belt);
 * the `_docTask` context + per-process nonce ride the payload so the router keys
 * by the thread scope and `handleMessage` routes the reply to the doc sink —
 * only when the nonce is authentic.
 */
export function synthesizeDocMentionMessage(
  mention: DocCommentMention,
  botUid: string,
  docTask: DocTaskContext,
  opts?: { docsBaseUrl?: string; now?: number },
): BotMessage {
  return {
    message_id: `doc_mention:${docTaskDedupeKey(mention)}`,
    message_seq: 0,
    from_uid: mention.fromUid,
    channel_id: docTaskSentinelChannelId(mention),
    channel_type: ChannelType.DM,
    timestamp: mention.enqueuedAt ?? opts?.now ?? Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content: formatDocMentionText(mention, opts),
      mention: { uids: [botUid] },
      [DOC_TASK_PAYLOAD_KEY]: docTask,
      [DOC_FIRE_NONCE_KEY]: DOC_FIRE_NONCE,
    },
  };
}
