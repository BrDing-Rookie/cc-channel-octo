/**
 * D1 — doc-fire authenticity marker (hard gate #1).
 *
 * Directly mirrors `cron-fire-marker.ts`. A synthesized doc-comment-mention
 * message rides the normal `handleMessage` pipeline carrying a `_docTask`
 * payload object that controls TWO privileged things:
 *   - session keying / mention-gate treatment (it is an authoritative server
 *     event, not a human @mention), and
 *   - the doc-comment SINK target (docId / threadId) that the bot's final reply
 *     is posted to.
 *
 * If we honored the bare `_docTask` key, a forged inbound WS payload could set
 * it and (a) impersonate a server doc task and (b) — far worse — steer the
 * bot's `postDocReply` at an attacker-chosen docId/threadId (a doc-side
 * spoof / comment-flood egress). So, exactly like cron, the poller stamps a
 * per-process secret nonce that never leaves the process; the router and the
 * dispatch path honor `_docTask` only when the nonce matches. An inbound WS
 * message can set `_docTask` but cannot know the nonce.
 *
 * Kept in its own tiny module so both the event poller (stamp, via
 * `doc-mention-handler`) and `session-router` (verify) depend on it without a
 * circular import.
 */
import { randomBytes } from "node:crypto";

/** Per-process secret. Regenerated each start — synthetic doc-task messages are
 *  in-memory and short-lived, so a fresh nonce per process is fine. */
export const DOC_FIRE_NONCE = randomBytes(16).toString("hex");

/** Payload key carrying the authenticity nonce on a synthetic doc-task message. */
export const DOC_FIRE_NONCE_KEY = "_docFireNonce";

/** Payload key carrying the doc-task context object (docId/threadId/scope/sink). */
export const DOC_TASK_PAYLOAD_KEY = "_docTask";

/**
 * True only for a GENUINE in-process doc-task fire: the `_docTask` context is
 * present AND the sibling nonce matches this process's secret. A forged inbound
 * payload can carry `_docTask` but not the secret nonce, so it does not pass.
 */
export function isAuthenticDocFire(payload: { [k: string]: unknown } | undefined | null): boolean {
  if (!payload || typeof payload !== "object") return false;
  const dt = (payload as Record<string, unknown>)[DOC_TASK_PAYLOAD_KEY];
  if (!dt || typeof dt !== "object") return false;
  return (payload as Record<string, unknown>)[DOC_FIRE_NONCE_KEY] === DOC_FIRE_NONCE;
}
