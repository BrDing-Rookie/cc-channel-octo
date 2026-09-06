/**
 * D1 — doc-mention wiring (ported/adapted from openclaw `doc-mention-handler.ts`
 * to cc's dispatch model).
 *
 * cc has no dispatch-context parameter: the reply sink lives INSIDE
 * `handleMessage` (branching on the authentic `_docTask` payload). So this
 * handler owns dedupe + fallback + dead-letter and hands `handleMessage` a
 * `DocTaskContext` whose `postComment` (bounded retry over D2's `postDocReply`)
 * and `reportTurn` it calls. The invariants openclaw hardened over four review
 * rounds are preserved:
 *
 *   1. Completion is judged by "the final answer actually landed"
 *      (`finalDelivered`), not "dispatch didn't throw".
 *   2. The turn reports FACTS; this file decides policy — and the two decisions
 *      (persist dedupe ← workLanded; post fallback ← user left hanging) are
 *      independent, so "answer landed + later error" neither loses the dedupe
 *      write nor stacks a bogus apology.
 *   3. Nothing throws out of here (incl. dedupe persist failure): the poller
 *      awaits this before ack, so throwing = no ack = replay of a doc edit.
 *   4. Events for another bot are dropped before claim (no foreign-key pollution).
 *   5. The fallback notice is posted only when the user is truly left hanging.
 */
import {
  docTaskSessionScope,
  docTaskDedupeKey,
  docCommentParentId,
  synthesizeDocMentionMessage,
  EMPTY_DOC_TASK_REPORT,
  type DocCommentMention,
  type DocTaskContext,
  type DocTaskTurnReport,
} from "./doc-mention.js";
import type { DocMentionDedupeStore } from "./doc-mention-dedupe.js";
import type { DocTaskDeadLetterStore } from "./doc-task-deadletter.js";
import type { BotMessage } from "./octo/types.js";
import { postDocReply, isPermanentDocCommentFailure, type DocReplyIntent } from "./doc-comment-outbound.js";

/** The pipeline entry: dispatch a synthesized doc-task message. Returns when the
 *  turn (incl. the final POST performed inside handleMessage) is done. */
export type DocMentionDispatch = (message: BotMessage) => Promise<void>;

export interface DocMentionHandlerDeps {
  botUid: string;
  apiUrl: string;
  botToken: string;
  /** Resolved docs service root (config.docsApiUrl ?? apiUrl) for the whole-doc URL. */
  docsBaseUrl?: string;
  dedupe: DocMentionDedupeStore;
  dispatch: DocMentionDispatch;
  /** Optional dead-letter sink; when absent, an undelivered task only logs. */
  deadLetter?: DocTaskDeadLetterStore;
  log?: { info?: (message: string) => void; error?: (message: string) => void };
}

/** Fallback comment when the turn left NO trace in the thread. Deliberately does
 *  not claim "no changes were made" (the answer POST may have failed after the
 *  doc was edited) — states only the half the user can verify. */
const NOTHING_DELIVERED_NOTICE = "⚠️ This document task produced no reply. Please retry or @ me again.";

/** A user notice occupies a short window; must not block the serial poller on the
 *  30s default doc-post timeout. */
export const DOC_TASK_NOTICE_TIMEOUT_MS = 10_000;

/** Bounded retry: one transient 5xx must not lose the whole reply. */
const POST_ATTEMPTS = 3;
const POST_RETRY_BASE_MS = 200;

export function createDocMentionHandler(deps: DocMentionHandlerDeps) {
  return async function handleDocMention(mention: DocCommentMention): Promise<void> {
    if (mention.botUid !== deps.botUid) {
      deps.log?.error?.(`octo: doc mention bot_uid=${mention.botUid} != this bot ${deps.botUid}, dropped`);
      return;
    }
    const dedupeKey = docTaskDedupeKey(mention);
    if (await deps.dedupe.claim(dedupeKey)) {
      deps.log?.info?.(`octo: doc mention ${dedupeKey} already processed, skipped`);
      return;
    }

    const parentId = docCommentParentId(mention);
    // Last error seen while posting the FINAL answer — used to classify a
    // dead-letter (permanent vs transient), architect gate #3.
    let lastFinalError: unknown;

    const postWithRetry = async (
      text: string,
      intent?: DocReplyIntent,
      signal?: AbortSignal,
    ): Promise<void> => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt += 1) {
        if (signal?.aborted) {
          lastErr ??= new Error(`octo: doc comment post aborted before attempt ${attempt}`);
          break;
        }
        try {
          await postDocReply({
            apiUrl: deps.apiUrl,
            botToken: deps.botToken,
            target: { docKind: mention.docKind, docId: mention.docId, parentId },
            body: text,
            intent,
            signal,
          });
          return;
        } catch (err) {
          lastErr = err;
          deps.log?.error?.(
            `octo: doc comment post failed (attempt ${attempt}/${POST_ATTEMPTS}) doc=${mention.docId}: ${String(err)}`,
          );
          // Deterministic failure (envelope reject / 4xx): retry cannot help.
          if (isPermanentDocCommentFailure(err)) break;
          if (signal?.aborted) break;
          if (attempt < POST_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, POST_RETRY_BASE_MS * attempt));
          }
        }
      }
      if (intent === "final" || intent === undefined) lastFinalError = lastErr;
      throw lastErr;
    };

    let reported: DocTaskTurnReport | undefined;
    const docTask: DocTaskContext = {
      docId: mention.docId,
      ...(mention.docKind ? { docKind: mention.docKind } : {}),
      threadId: mention.threadId,
      commentId: mention.commentId,
      ...(parentId ? { parentId } : {}),
      sessionScope: docTaskSessionScope(mention),
      postComment: postWithRetry,
      reportTurn: (value) => {
        reported = reported
          ? {
              finalDelivered: reported.finalDelivered || value.finalDelivered,
              delivered: reported.delivered || value.delivered,
              lost: reported.lost || value.lost,
              noticed: reported.noticed || value.noticed,
            }
          : value;
      },
    };

    try {
      await deps.dispatch(
        synthesizeDocMentionMessage(mention, deps.botUid, docTask, { docsBaseUrl: deps.docsBaseUrl }),
      );
    } catch (err) {
      deps.log?.error?.(
        `octo: doc task dispatch failed doc=${mention.docId} thread=${mention.threadId}: ${String(err)}`,
      );
    }

    const report = reported ?? EMPTY_DOC_TASK_REPORT;
    // Two independent decisions (see header invariant 2). Does NOT consult a
    // dispatch return code: a thrown dispatch is "it broke", not "it didn't run".
    const workLanded = report.finalDelivered;
    const userLeftHanging = !workLanded && !report.noticed;

    deps.log?.info?.(
      `octo: doc task doc=${mention.docId} thread=${mention.threadId} workLanded=${workLanded} ` +
        `final=${report.finalDelivered} delivered=${report.delivered} lost=${report.lost} noticed=${report.noticed}`,
    );

    if (userLeftHanging) {
      let noticeErr: unknown;
      try {
        await postWithRetry(
          NOTHING_DELIVERED_NOTICE,
          // Must be explicit "notice": the default would render as "applied"
          // (resolved), the exact opposite of "no reply given".
          "notice",
          AbortSignal.timeout(DOC_TASK_NOTICE_TIMEOUT_MS),
        );
      } catch (err) {
        noticeErr = err;
        deps.log?.error?.(
          `octo: doc task fallback notice failed doc=${mention.docId} thread=${mention.threadId}: ${String(err)}`,
        );
      }
      // Dead-letter: answer AND fallback both failed, and the event will be
      // acked — nothing left in the system. Persist a record (NOT a replay
      // queue). Classify permanent vs transient from the final-answer error.
      if (noticeErr !== undefined && deps.deadLetter) {
        const classifyErr = lastFinalError ?? noticeErr;
        await deps.deadLetter.record({
          key: dedupeKey,
          docId: mention.docId,
          threadId: mention.threadId,
          commentId: mention.commentId,
          at: new Date().toISOString(),
          reason: isPermanentDocCommentFailure(classifyErr) ? "permanent_failure" : "undelivered_after_ack",
          detail: String(lastFinalError ?? noticeErr),
        });
      }
    }

    if (workLanded) {
      try {
        await deps.dedupe.complete(dedupeKey);
      } catch (err) {
        // Invariant 3: work done + answer delivered; only the dedupe record was
        // lost. The event is acked next; do not throw (that replays a doc edit).
        deps.log?.error?.(
          `octo: doc mention dedupe persist failed key=${dedupeKey} doc=${mention.docId}: ${String(err)}`,
        );
      }
      return;
    }

    deps.dedupe.release(dedupeKey);
  };
}
