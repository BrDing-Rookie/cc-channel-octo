/**
 * D2 — document-comment outbound reply.
 *
 * Ported from openclaw-channel-octo (the outbound half of its doc-task chain).
 * The wire endpoints — `postDocComment` (CRDT docs, keyed by docId) and
 * `postHtmlDocReply` (octo-doc HTML, keyed by slug) — landed with batch 0 in
 * `octo/api.ts`; this module is the thin dispatch + failure-classification layer
 * on top of them, so callers (D1's handler, its bounded-retry, its fallback
 * notice) route one way regardless of the document backend.
 *
 * Two documents, one reply surface:
 *   - HTML doc (`docKind === "html"`): the reply carries an **intent** that maps
 *     to a comment status badge (`final → applied`, `progress → partial`,
 *     `notice → question`; see `docReplyStatusOf`). `progress` MUST stay distinct
 *     from `final` so a mid-task frame never flips the parent comment to resolved.
 *   - CRDT doc (default): `postDocComment` has **no** status field — the docs
 *     backend does not carry a per-comment badge — so `intent` is accepted for a
 *     uniform signature but is a no-op there. This matches the openclaw contract
 *     (its `postDocComment` took no intent either); do not fabricate a badge the
 *     backend will not honor.
 */
import {
  postDocComment,
  postHtmlDocReply,
  type DocReplyIntent,
} from "./octo/api.js";

export type { DocReplyIntent } from "./octo/api.js";
export { isPermanentDocCommentFailure } from "./octo/api.js";

/**
 * Where a doc reply goes. `docId` is the CRDT document id, or the octo-doc
 * **slug** when `docKind === "html"`. `parentId` is the comment-thread root as a
 * DECIMAL STRING (snowflake ids overflow JS numbers, so they stay strings all the
 * way to the wire); `undefined` posts at the thread root.
 */
export interface DocReplyTarget {
  docKind?: "html";
  docId: string;
  parentId?: string;
}

/**
 * Post one reply under a document's comment thread, dispatching to the right
 * backend by `docKind`. Rejects with the same error shapes the callers classify
 * via `isPermanentDocCommentFailure` (`DocCommentRejectedError` for a business
 * rejection, an `Octo API … failed (<status>)` Error for HTTP failures), so the
 * retry / permanent-failure decision lives in one place for both backends.
 */
export async function postDocReply(params: {
  apiUrl: string;
  botToken: string;
  target: DocReplyTarget;
  body: string;
  intent?: DocReplyIntent;
  signal?: AbortSignal;
}): Promise<void> {
  const { apiUrl, botToken, target, body, intent, signal } = params;
  if (target.docKind === "html") {
    // octo-doc's agent-reply path is keyed by slug and always attaches under a
    // parent comment; an empty parent_id is a request-shape error the backend
    // rejects (→ permanent failure → dead-letter), which is the correct, visible
    // outcome rather than a silent mis-post.
    await postHtmlDocReply({
      apiUrl,
      botToken,
      slug: target.docId,
      parentId: target.parentId ?? "",
      body,
      intent,
      signal,
    });
    return;
  }
  // CRDT docs: no status badge on this backend, so `intent` carries no wire
  // effect here (see module header). `parentId === undefined` → root comment.
  await postDocComment({
    apiUrl,
    botToken,
    docId: target.docId,
    parentId: target.parentId,
    body,
    signal,
  });
}
