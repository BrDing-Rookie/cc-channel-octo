/**
 * A7 — reasoning/thinking text desensitization (4-state classification).
 *
 * The agent's reasoning lane (Claude Agent SDK `thinking` / `redacted_thinking`
 * content blocks) is visible to channel members once it lands on a progress /
 * reasoning card, so it MUST be classified and desensitized before display. This
 * is the hard security acceptance item for A6/A7; it is deliberately a standalone,
 * side-effect-free module so it can be unit-tested independently of the state
 * machine and reused by whichever render path (local card now, server
 * `ai.reasoning-process` template later) ends up surfacing the text.
 *
 * The four kinds are kept DISTINCT on purpose — collapsing them loses the only
 * operator-actionable signal (`redacted`, "our guard withheld this"):
 *   - `text`       — clean, displayable reasoning text.
 *   - `none`       — no reasoning content at all (nothing to render).
 *   - `no-summary` — the model demonstrably reasoned but returned no readable
 *                    text (Anthropic `redacted_thinking`, or a signed thinking
 *                    block with empty text). Set by the caller at the SDK event
 *                    boundary via `noSummaryThought()`.
 *   - `redacted`   — OUR fail-closed guard withheld it: it matched an internal
 *                    context marker, tripped the sensitive-data detector, or was
 *                    a bare URL we downgraded away. A hit does NOT prove a secret
 *                    was present (long hex / git SHAs trip it too); it only tells
 *                    an operator where to look, so it stays distinguishable.
 */
import { isSensitive, reduceUrlsInText } from "./card-render.js";

export type ReasoningThoughtKind = "text" | "none" | "no-summary" | "redacted";

export interface ReasoningThought {
  kind: ReasoningThoughtKind;
  /** Display string; empty for `none`, where no thought line is rendered at all. */
  text: string;
}

/** The model reasoned but returned no readable summary (redacted_thinking / empty signed block). */
export const NO_SUMMARY_THOUGHT = "Reasoned without a visible summary";

/** Our own fail-closed guard withheld the text. Points at the rule, not the content. */
export const REDACTED_THOUGHT = "Reasoning hidden — matched a redaction rule";

/**
 * Per-thought display ceiling (a "…" is appended on truncation, so leave a char).
 * Capture is separately bounded upstream in card-progress.ts.
 */
export const THOUGHT_MAX = 280;

/**
 * Runtime-internal context marker, tolerant match. A fixed substring is defeated
 * by swapping the underscore (`INTERNAL~CONTEXT`) or padding the middle, so we
 * only require the `<<<` … BEGIN/END … INTERNAL fragments to appear with
 * arbitrary non-alphanumeric filler between them. Prefer over-hiding.
 */
const INTERNAL_CONTEXT_MARKER_RE =
  /<<<[^A-Za-z0-9]*(?:BEGIN|END)[^A-Za-z0-9]*[A-Za-z0-9]*[^A-Za-z0-9]*INTERNAL/i;

/** Control characters stripped before classification (keeps matching + display clean). */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * The `no-summary` thought — a model reasoned but returned no readable text. Set
 * by the SDK event boundary (redacted_thinking block, or a signed-but-empty
 * thinking block) rather than inferred from content.
 */
export function noSummaryThought(): ReasoningThought {
  return { kind: "no-summary", text: NO_SUMMARY_THOUGHT };
}

/**
 * Classify + desensitize a raw reasoning string. Fail closed on any
 * protected/secret shape: the reasoning lane is channel-visible.
 */
export function resolveReasoningThought(text: string | undefined): ReasoningThought {
  if (!text) return { kind: "none", text: "" };
  // Strip control characters and collapse whitespace before any matching.
  const normalized = text.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  // Whitespace-only input carries no reasoning; it is not something we withheld.
  if (!normalized) return { kind: "none", text: "" };
  // Internal context marker: the host wraps runtime-generated private context in
  // it, so rendering it would leak internal detail to the channel. Check before
  // URL reduction (reduction can rearrange the marker fragments).
  if (INTERNAL_CONTEXT_MARKER_RE.test(normalized)) {
    return { kind: "redacted", text: REDACTED_THOUGHT };
  }
  const reduced = reduceUrlsInText(normalized).replace(/\s+/g, " ").trim();
  // Empty after URL reduction means the whole thought was a URL we downgraded
  // away: withheld, not absent, so it stays distinguishable from `none`.
  if (!reduced || isSensitive(reduced, true)) {
    return { kind: "redacted", text: REDACTED_THOUGHT };
  }
  // Re-check the marker after reduction: reduction can splice previously-broken
  // fragments back together.
  if (INTERNAL_CONTEXT_MARKER_RE.test(reduced)) {
    return { kind: "redacted", text: REDACTED_THOUGHT };
  }
  return {
    kind: "text",
    text: reduced.length > THOUGHT_MAX ? reduced.slice(0, THOUGHT_MAX) + "…" : reduced,
  };
}

/** Display string for a captured thought. See resolveReasoningThought for the classification. */
export function sanitizeReasoningThought(text: string | undefined): string {
  return resolveReasoningThought(text).text;
}
