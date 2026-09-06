/**
 * A6 — real-time progress card state machine (thinking / tool / answering / done).
 *
 * OpenClaw builds this card from 8 lifecycle hooks (before/after_tool_call,
 * model_call_started/ended, sessions_yield, agent_end, …). The Claude Agent SDK
 * exposes none of those; it gives a `query()` message stream. So cc rebuilds the
 * equivalent state machine on {@link AgentStreamEvent}s derived from that stream
 * (see agent-bridge.ts) plus the existing `onToolUse` surface, and renders the
 * card LOCALLY via {@link renderProgressCard} → `sendCardMessage`/`editCardMessage`
 * (cc has no dependency on the server `ai.reasoning-process` template for this
 * card — that path belongs to A7 and is deferred).
 *
 * Design decisions:
 *   - Association key is the `sessionKey` (same key the dispatcher uses). The Map
 *     object identity is the generation fence: a stale entry (replaced by the next
 *     turn on the same session) must never produce a network side effect.
 *   - LAZY send: the placeholder card is only sent once the first real (non-
 *     thinking) tool step exists. A pure-text or pure-thinking turn sends NO card,
 *     so a plain answer is never shadowed by a stray "Working…" card.
 *   - DEBOUNCED edits (`FLUSH_DEBOUNCE_MS`): rapid tool events coalesce into one
 *     edit; card_seq is monotonic so the server's CAS never sees an out-of-order
 *     frame. Mid-frames are `transient` (kept out of the D10 revision history);
 *     the terminal frame is recorded.
 *   - RATE-LIMIT COOLDOWN: a 429 opens a per-apiUrl cooldown window; progress
 *     frames are discardable, so we hold the latest state and flush once at the
 *     end of the window instead of hammering the bucket the server just closed.
 *   - Subagent yield/resume (OpenClaw `sessions_yield`) has NO SDK primitive, so
 *     the paused/resuming sub-capability is intentionally SKIPPED (it does not
 *     block the A6 main body). The render layer keeps those phases for parity, but
 *     this driver never produces them.
 *
 * Failures never propagate: a broken progress card must not break the answer.
 */
import {
  renderProgressCard,
  summarizeToolParams,
  type CardCaps,
  type CardProgressState,
  type CardStep,
} from "./card-render.js";
import { noSummaryThought, resolveReasoningThought } from "./reasoning-thought.js";
import type { AgentStreamEvent } from "./agent-bridge.js";
import { editCardMessage, deriveCardCaps, getCardProfile, httpStatusFromApiFetchError, sendCardMessage } from "./octo/api.js";
import type { ChannelType } from "./octo/types.js";

/** Dispatch-registered send context for one session's progress card. */
export interface ProgressCardContext {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  /** Server-negotiated card capabilities (getCardProfile → deriveCardCaps). */
  caps?: CardCaps;
  /**
   * A7: whether captured reasoning text may be surfaced. Default OFF (privacy
   * first). When on, thinking text is still 4-state classified + desensitized via
   * resolveReasoningThought before it is ever stored on a step.
   */
  showReasoning?: boolean;
}

interface CardEntry {
  ctx: ProgressCardContext;
  /**
   * Turn-level generation fence. `setCardContext` stamps a fresh, strictly
   * increasing value per turn; every public entry point (event / finalize / stop)
   * is keyed by a {@link CardHandle} carrying the generation it was issued for and
   * no-ops when the live entry has moved on. This is what stops a turn whose
   * dispatch timed out — but whose SDK stream keeps running in the background (see
   * session-router.ts, "we do NOT cancel the in-flight turn") — from writing its
   * late thinking/tool/text into, or prematurely terminating, the NEXT turn's card.
   */
  generation: number;
  messageId?: string;
  phase: CardProgressState["phase"];
  steps: CardStep[];
  startedAt: number;
  dirty: boolean;
  inFlight: boolean;
  skip: boolean;
  /** Sticky user-abort / dispatch-timeout flag; freezes intake so the card settles as "stopped". */
  stopped: boolean;
  /** Subtype of a non-success SDK `result` (e.g. `error_max_turns`), surfaced on the error frame. */
  terminalError?: string;
  /**
   * The recorded terminal frame this entry still owes. Set by finalizeCard /
   * markStopped, after which the entry is DETACHED from the `cards` map and its
   * send is driven by an independent lifecycle ({@link deliverTerminal}) — so a
   * superseding turn's {@link setCardContext} (which cancels the live entry's
   * timers) can never cancel a terminal frame that is merely waiting out a 429
   * cooldown or a debounce. It honors the same 429 window and retries, not drops,
   * on a further 429.
   */
  terminal?: { phase: CardProgressState["phase"]; errorText?: string };
  /** Independent retry timer for a detached terminal frame (see {@link deliverTerminal}). */
  terminalTimer?: ReturnType<typeof setTimeout>;
  /** Failed terminal-send attempts, bounding the transient/rate-limited retry loop. */
  terminalAttempts?: number;
  flushTimer?: ReturnType<typeof setTimeout>;
  /** In-flight flush promise; finalizeCard awaits it so the terminal frame lands last. */
  flushPromise?: Promise<void>;
  cooldownTimer?: ReturnType<typeof setTimeout>;
  /** Next positive CAS value for an edit. */
  nextCardSeq: number;
}

/**
 * Opaque per-turn handle returned by {@link setCardContext}. The dispatcher passes
 * it back to {@link handleAgentEvent} / {@link finalizeCard} / {@link markStopped};
 * each call is a no-op unless the live entry for `sessionKey` is still this exact
 * `generation`. See {@link CardEntry.generation}.
 */
export interface CardHandle {
  readonly sessionKey: string;
  readonly generation: number;
}

const FLUSH_DEBOUNCE_MS = 800;
const EDIT_TIMEOUT_MS = 10_000;
/** Fixed cooldown on a 429 — postJson does not surface Retry-After. Progress is discardable. */
const RATE_LIMIT_COOLDOWN_MS = 30_000;
/** Raw thinking text is bounded here before desensitization (which caps display separately). */
const MAX_REASONING_CAPTURE = 4_000;
/** Bound stored steps against a pathologically long run; the renderer caps what is shown. */
const MAX_TRACKED_STEPS = 300;
/** Backoff for a transient / in-flight-collision retry of a detached terminal frame. */
const TERMINAL_RETRY_MS = 500;
/** Bound a detached terminal's retry loop so a persistently-sick backend can't spin forever. */
const MAX_TERMINAL_ATTEMPTS = 15;
const THINKING_TOOL = "__thinking__";

/** cc bots are a single identity per config, so a plain module Map suffices. */
const cards = new Map<string, CardEntry>();
/** Strictly increasing turn-generation source (see {@link CardEntry.generation}). */
let generationSeq = 0;
/**
 * Latest synchronously-reserved turn token per session ({@link reserveTurn}). Lets
 * the dispatcher claim ordering BEFORE the async prelude (member refresh / history /
 * profile probe) that precedes {@link setCardContext}, so a turn whose dispatch timed
 * out during that prelude can detect it has been superseded and refuse to install a
 * card that would clobber the live turn.
 */
const turnReservations = new Map<string, number>();
/**
 * Entries that have been terminalized (finalize / stop) and DETACHED from `cards`,
 * each draining its recorded terminal frame on an independent lifecycle so a
 * superseding turn cannot cancel it. See {@link beginTerminal} / {@link deliverTerminal}.
 */
const pendingTerminals = new Set<CardEntry>();
/** Earliest time each backend may receive another progress frame, keyed by apiUrl. */
const rateLimitedUntil = new Map<string, number>();

/** Per-bot D12 profile cache (gate + caps), so a card is not a GET-per-turn tax. */
const capsCache = new Map<string, { enabled: boolean; caps?: CardCaps; expires: number }>();
const CAPS_TTL_MS = 5 * 60 * 1000;
const PROFILE_TIMEOUT_MS = 5_000;

/**
 * Resolve the progress card's gate + capabilities from the server D12 profile,
 * cached per bot. FAIL-CLOSED: an unavailable / malformed manifest, a disabled
 * `display_enabled`, or any probe failure all read as `enabled:false` (no card
 * this turn). Mirrors the display-card tool's gate so both features agree.
 */
export async function resolveProgressCardCaps(
  apiUrl: string,
  botToken: string,
): Promise<{ enabled: boolean; caps?: CardCaps }> {
  const key = `${apiUrl} ${botToken}`;
  const now = Date.now();
  const cached = capsCache.get(key);
  if (cached && cached.expires > now) {
    return { enabled: cached.enabled, ...(cached.caps ? { caps: cached.caps } : {}) };
  }
  try {
    const manifest = await getCardProfile({ apiUrl, botToken, signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS) });
    const enabled = manifest.available && manifest.config?.display_enabled === true;
    const caps = enabled ? deriveCardCaps(manifest) : undefined;
    capsCache.set(key, { enabled, ...(caps ? { caps } : {}), expires: now + CAPS_TTL_MS });
    return { enabled, ...(caps ? { caps } : {}) };
  } catch (err) {
    // Transient (5xx / network / timeout): do not cache a negative, so the next
    // turn re-probes. The caller degrades to no card this turn.
    warn(`card profile probe failed: ${err instanceof Error ? err.message : String(err)}`);
    return { enabled: false };
  }
}

/** Test helper: drop the profile cache. */
export function _resetProgressCapsCacheForTests(): void {
  capsCache.clear();
}

// Progress-card failures never break the answer stream — warn only, never throw.
const warn = (msg: string): void => console.warn(`[cc-channel-octo:progress] ${msg}`);

function cooldownKey(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, "");
}

function cooldownRemainingMs(apiUrl: string): number {
  return Math.max(0, (rateLimitedUntil.get(cooldownKey(apiUrl)) ?? 0) - Date.now());
}

function noteRateLimited(apiUrl: string): void {
  const key = cooldownKey(apiUrl);
  // Monotonic: a concurrent shorter window must not shorten an existing one.
  rateLimitedUntil.set(key, Math.max(rateLimitedUntil.get(key) ?? 0, Date.now() + RATE_LIMIT_COOLDOWN_MS));
}

function clearCooldownTimer(entry: CardEntry): void {
  if (entry.cooldownTimer) {
    clearTimeout(entry.cooldownTimer);
    entry.cooldownTimer = undefined;
  }
}

/** entry is still the current generation for this session AND allowed side effects. */
function isCurrentEntry(sessionKey: string, entry: CardEntry): boolean {
  return cards.get(sessionKey) === entry && !entry.skip;
}

/**
 * Resolve a {@link CardHandle} to its live entry, but ONLY when the entry still
 * carries the handle's generation. A superseded turn (its generation replaced by a
 * later {@link setCardContext}) resolves to `undefined`, so its late events and its
 * own finalize become no-ops against the new turn's card.
 */
function entryFor(handle: CardHandle): CardEntry | undefined {
  const entry = cards.get(handle.sessionKey);
  if (!entry || entry.generation !== handle.generation) return undefined;
  return entry;
}

/**
 * Reserve this session's next logical turn SYNCHRONOUSLY, at handler entry, before
 * the async prelude that precedes {@link setCardContext}. A later turn on the same
 * session can only begin after THIS turn's dispatch timeout releases the session
 * lock, so it will always reserve a higher token. The dispatcher passes the token to
 * {@link isCurrentTurn} right before installing the card: a turn that timed out and
 * resumed after a newer turn started sees it is no longer current and declines to
 * install — closing the window where a zombie turn's {@link setCardContext} would
 * supersede (and skip) the live turn's card. Returns 0 for an empty key (never current).
 */
export function reserveTurn(sessionKey: string): number {
  if (!sessionKey) return 0;
  const token = ++generationSeq;
  turnReservations.set(sessionKey, token);
  return token;
}

/** True iff `token` is still the latest reservation for the session (no newer turn began). */
export function isCurrentTurn(sessionKey: string, token: number): boolean {
  return token !== 0 && turnReservations.get(sessionKey) === token;
}

/**
 * Register the send context at dispatch start and return the turn's {@link CardHandle}.
 * Replaces any prior generation: the old entry's pending timers are cancelled and it
 * is marked skip so a late flush cannot fire against the new turn. The returned handle
 * fences every later event/finalize/stop to THIS turn's generation.
 */
export function setCardContext(sessionKey: string, ctx: ProgressCardContext): CardHandle {
  // Empty key → a handle whose generation (0) can never match a real entry, so all
  // subsequent calls no-op. (generationSeq starts at 0; the first real turn is 1.)
  if (!sessionKey) return { sessionKey, generation: 0 };
  const existing = cards.get(sessionKey);
  if (existing) {
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    clearCooldownTimer(existing);
    existing.skip = true;
  }
  const generation = ++generationSeq;
  cards.set(sessionKey, {
    ctx,
    generation,
    phase: "thinking",
    steps: [],
    startedAt: Date.now(),
    dirty: false,
    inFlight: false,
    skip: false,
    stopped: false,
    nextCardSeq: 1,
  });
  return { sessionKey, generation };
}

/** Hard cleanup (no terminal frame). Used for abnormal teardown. */
export function clearCard(sessionKey: string): void {
  const entry = cards.get(sessionKey);
  if (entry) {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    clearCooldownTimer(entry);
    if (entry.terminalTimer) clearTimeout(entry.terminalTimer);
    entry.skip = true;
  }
  cards.delete(sessionKey);
}

/** Test helper: drop all state. */
export function _resetProgressCardsForTests(): void {
  for (const entry of cards.values()) {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    clearCooldownTimer(entry);
    if (entry.terminalTimer) clearTimeout(entry.terminalTimer);
    entry.skip = true;
  }
  for (const entry of pendingTerminals) {
    if (entry.terminalTimer) clearTimeout(entry.terminalTimer);
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    clearCooldownTimer(entry);
  }
  cards.clear();
  pendingTerminals.clear();
  turnReservations.clear();
  rateLimitedUntil.clear();
}

function hasRealStep(entry: CardEntry): boolean {
  return entry.steps.some((s) => s.tool !== THINKING_TOOL);
}

/** Close the last running thinking step, stamping its duration. */
function endRunningThinking(entry: CardEntry, now: number): void {
  const last = entry.steps[entry.steps.length - 1];
  if (!last || last.tool !== THINKING_TOOL || last.status !== "running") return;
  last.status = "done";
  if (typeof last.startedAt === "number") last.durationMs = Math.max(0, now - last.startedAt);
}

/** Keep the tracked-step count bounded on a very long run (drop oldest settled steps). */
function trimSteps(entry: CardEntry): void {
  if (entry.steps.length <= MAX_TRACKED_STEPS) return;
  const overflow = entry.steps.length - MAX_TRACKED_STEPS;
  let removed = 0;
  entry.steps = entry.steps.filter((step) => {
    if (removed >= overflow) return true;
    if (step.status === "running") return true;
    removed++;
    return false;
  });
}

function scheduleFlush(sessionKey: string, entry: CardEntry): void {
  entry.dirty = true;
  if (entry.flushTimer) return;
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = undefined;
    void flush(sessionKey);
  }, FLUSH_DEBOUNCE_MS);
}

function armCooldownWake(sessionKey: string, entry: CardEntry, delayMs: number): void {
  if (entry.cooldownTimer) return;
  entry.cooldownTimer = setTimeout(() => {
    entry.cooldownTimer = undefined;
    if (!isCurrentEntry(sessionKey, entry)) return;
    const remaining = cooldownRemainingMs(entry.ctx.apiUrl);
    if (remaining > 0) {
      armCooldownWake(sessionKey, entry, remaining);
      return;
    }
    if (entry.dirty) void flush(sessionKey);
  }, delayMs);
}

function progressState(entry: CardEntry, phase = entry.phase, errorText?: string): CardProgressState {
  return {
    phase,
    steps: entry.steps,
    elapsedMs: Date.now() - entry.startedAt,
    ...(errorText ? { errorText } : {}),
  };
}

/** Deterministic 4xx (not 429) → give up on this session; 429 → cooldown; else transient. */
function classifyError(err: unknown): "deterministic" | "rate-limited" | "transient" {
  const status = httpStatusFromApiFetchError(err);
  if (status === 429) return "rate-limited";
  if (status !== undefined && status >= 400 && status < 500) return "deterministic";
  return "transient";
}

async function flush(sessionKey: string): Promise<void> {
  const entry = cards.get(sessionKey);
  if (!entry || entry.skip || !entry.dirty || entry.inFlight) return;

  const cooldown = cooldownRemainingMs(entry.ctx.apiUrl);
  if (cooldown > 0) {
    armCooldownWake(sessionKey, entry, cooldown); // hold latest state; flush when it clears
    return;
  }

  entry.inFlight = true;
  const work = runFlush(sessionKey, entry);
  entry.flushPromise = work;
  try {
    await work;
  } finally {
    if (entry.flushPromise === work) entry.flushPromise = undefined;
    entry.inFlight = false;
    if (pendingTerminals.has(entry)) {
      // The entry terminalized (stop/finalize) while this flush was in flight — its
      // deliverTerminal deferred on inFlight. If that in-flight send DISABLED the
      // entry (deterministic 4xx, or a success with no message_id → skip), do NOT
      // retry: a deterministic failure must give up, and a card that may already
      // exist server-side must not be sent twice. Otherwise drain the recorded
      // terminal onto the SAME card (message_id was recorded above).
      if (entry.skip) {
        dropTerminal(entry);
      } else {
        void deliverTerminal(entry);
      }
    } else if (entry.dirty && !entry.skip && cards.get(sessionKey) === entry &&
        cooldownRemainingMs(entry.ctx.apiUrl) === 0) {
      scheduleFlush(sessionKey, entry);
    }
  }
}

async function runFlush(sessionKey: string, entry: CardEntry): Promise<void> {
  entry.dirty = false;
  const signal = AbortSignal.timeout(EDIT_TIMEOUT_MS);
  // Mid-frame only: transient (kept out of the D10 revision history). The terminal
  // frame is NOT sent from here — once an entry terminalizes it is detached from the
  // `cards` map and drained by {@link deliverTerminal} on its own lifecycle.
  const { card, plain } = renderProgressCard(progressState(entry), entry.ctx.caps);
  try {
    if (!entry.messageId) {
      const res = await sendCardMessage({
        apiUrl: entry.ctx.apiUrl,
        botToken: entry.ctx.botToken,
        channelId: entry.ctx.channelId,
        channelType: entry.ctx.channelType,
        card,
        plain,
        signal,
      });
      // Record the message_id when this entry is still the live card OR has entered
      // the terminal lifecycle (detached into pendingTerminals because it was stopped/
      // finalized while this very first-frame send was in flight). Dropping it there
      // would leave the detached terminal with no messageId → it would send a SECOND
      // card. Only a stale entry that a NEW turn superseded (and that never
      // terminalized) discards the response.
      if (!isCurrentEntry(sessionKey, entry) && !pendingTerminals.has(entry)) return;
      entry.messageId = res?.message_id;
      if (!entry.messageId) {
        warn("placeholder card send returned no message_id; disabling for session");
        entry.skip = true;
      }
    } else {
      await editCardMessage({
        apiUrl: entry.ctx.apiUrl,
        botToken: entry.ctx.botToken,
        messageId: entry.messageId,
        channelId: entry.ctx.channelId,
        channelType: entry.ctx.channelType,
        card,
        plain,
        cardSeq: entry.nextCardSeq++,
        transient: true,
        signal,
      });
    }
  } catch (err) {
    handleFlushError(sessionKey, entry, err, "flush");
  }
}

// ─── Detached terminal delivery ────────────────────────────────────────────────
//
// A card that has terminalized (done / error / stopped) must reach its RECORDED
// terminal frame even if a new turn starts on the same session moments later. The
// live-entry flush path is keyed by the `cards` map, and setCardContext cancels the
// prior entry's timers — so a terminal frame merely waiting out a 429 cooldown (or a
// debounce) would be silently cancelled by an immediate retry. To prevent that,
// terminalization DETACHES the entry from the map and drains it here, independent of
// whatever turn currently owns the session.

/**
 * Terminalize an entry: record its terminal frame, cancel its mid-frame timers, and
 * DETACH it from the `cards` map so a superseding {@link setCardContext} cannot touch
 * it. The caller then kicks {@link deliverTerminal}.
 */
function beginTerminal(
  entry: CardEntry,
  sessionKey: string,
  phase: CardProgressState["phase"],
  errorText?: string,
): void {
  entry.terminal = { phase, ...(errorText ? { errorText } : {}) };
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = undefined;
  }
  clearCooldownTimer(entry);
  entry.dirty = false;
  // Detach: a fresh turn's setCardContext(sessionKey) now creates a new entry and
  // never cancels this one's terminal send.
  if (cards.get(sessionKey) === entry) cards.delete(sessionKey);
  pendingTerminals.add(entry);
}

function scheduleTerminalRetry(entry: CardEntry, delayMs: number): void {
  if (entry.terminalTimer) return;
  entry.terminalTimer = setTimeout(() => {
    entry.terminalTimer = undefined;
    void deliverTerminal(entry);
  }, Math.max(0, delayMs));
}

/** Terminal frame delivered (or abandoned): cancel the retry timer, forget the entry. */
function dropTerminal(entry: CardEntry): void {
  if (entry.terminalTimer) {
    clearTimeout(entry.terminalTimer);
    entry.terminalTimer = undefined;
  }
  entry.terminal = undefined;
  pendingTerminals.delete(entry);
}

/**
 * Drain a detached entry's recorded terminal frame. Honors the 429 cooldown (holds +
 * retries when the window clears, never appends a request the server just closed),
 * retries transient/rate-limited failures up to {@link MAX_TERMINAL_ATTEMPTS}, and
 * gives up on a deterministic 4xx. Independent of the `cards` map, so a superseding
 * turn cannot cancel it. Never throws.
 */
async function deliverTerminal(entry: CardEntry): Promise<void> {
  if (!entry.terminal || !pendingTerminals.has(entry)) return;
  // Disabled (deterministic 4xx earlier, or a placeholder send that returned no
  // message_id): never send — give up and drop. Defense in depth for every entry
  // point (flush's finally already screens this; the retry timer path relies on it).
  if (entry.skip) { dropTerminal(entry); return; }
  // A mid-frame flush from before terminalization may still be in flight; let it
  // finish first so the terminal frame is strictly last, then retry.
  if (entry.inFlight) { scheduleTerminalRetry(entry, TERMINAL_RETRY_MS); return; }
  // Nothing worth showing (pure text/thinking turn that never sent a card): stay silent.
  if (!entry.messageId && !hasRealStep(entry)) { dropTerminal(entry); return; }
  // Respect the 429 window: hold the terminal and flush once it clears.
  const cooldown = cooldownRemainingMs(entry.ctx.apiUrl);
  if (cooldown > 0) { scheduleTerminalRetry(entry, cooldown); return; }

  // Committed to a send now — cancel any pending retry so a timer firing during the
  // await cannot spawn a redundant concurrent attempt.
  if (entry.terminalTimer) {
    clearTimeout(entry.terminalTimer);
    entry.terminalTimer = undefined;
  }
  entry.inFlight = true;
  const signal = AbortSignal.timeout(EDIT_TIMEOUT_MS);
  const state = progressState(entry, entry.terminal.phase, entry.terminal.errorText);
  const { card, plain } = renderProgressCard(state, entry.ctx.caps);
  try {
    if (!entry.messageId) {
      const res = await sendCardMessage({
        apiUrl: entry.ctx.apiUrl,
        botToken: entry.ctx.botToken,
        channelId: entry.ctx.channelId,
        channelType: entry.ctx.channelType,
        card,
        plain,
        signal,
      });
      entry.messageId = res?.message_id;
      if (!entry.messageId) {
        warn("terminal card send returned no message_id");
        dropTerminal(entry);
        return;
      }
    } else {
      await editCardMessage({
        apiUrl: entry.ctx.apiUrl,
        botToken: entry.ctx.botToken,
        messageId: entry.messageId,
        channelId: entry.ctx.channelId,
        channelType: entry.ctx.channelType,
        card,
        plain,
        cardSeq: entry.nextCardSeq++,
        // Terminal frame is recorded (NOT transient) so it enters the revision history.
        signal,
      });
    }
    dropTerminal(entry);
  } catch (err) {
    const kind = classifyError(err);
    warn(`terminal delivery failed (${kind}): ${err instanceof Error ? err.message : String(err)}`);
    entry.terminalAttempts = (entry.terminalAttempts ?? 0) + 1;
    if (kind === "deterministic" || entry.terminalAttempts >= MAX_TERMINAL_ATTEMPTS) {
      dropTerminal(entry);
    } else if (kind === "rate-limited") {
      noteRateLimited(entry.ctx.apiUrl);
      scheduleTerminalRetry(entry, cooldownRemainingMs(entry.ctx.apiUrl) || RATE_LIMIT_COOLDOWN_MS);
    } else {
      scheduleTerminalRetry(entry, TERMINAL_RETRY_MS);
    }
  } finally {
    entry.inFlight = false;
  }
}

function handleFlushError(sessionKey: string, entry: CardEntry, err: unknown, where: string): void {
  const kind = classifyError(err);
  warn(`${where} failed (${kind}): ${err instanceof Error ? err.message : String(err)}`);
  if (kind === "deterministic") {
    entry.skip = true;
    clearCooldownTimer(entry);
    return;
  }
  if (kind === "rate-limited") {
    noteRateLimited(entry.ctx.apiUrl);
    // Re-mark dirty so the held frame is flushed when the window clears, not dropped.
    if (isCurrentEntry(sessionKey, entry)) {
      entry.dirty = true;
      armCooldownWake(sessionKey, entry, cooldownRemainingMs(entry.ctx.apiUrl));
    }
  }
  // transient: drop this frame; the next event reschedules a flush.
}

// ─── Event intake ────────────────────────────────────────────────────────────

function onThinking(sessionKey: string, entry: CardEntry, ev: Extract<AgentStreamEvent, { kind: "thinking" }>): void {
  const now = Date.now();
  // Dedup: fold into the current running thinking step rather than stacking.
  let step = entry.steps[entry.steps.length - 1];
  if (!step || step.tool !== THINKING_TOOL || step.status !== "running") {
    step = { tool: THINKING_TOOL, status: "running", startedAt: now };
    entry.steps.push(step);
    trimSteps(entry);
  }
  if (!hasRealStep(entry)) entry.phase = "thinking";
  // A7: capture only when reasoning is allowed, and ALWAYS through desensitization.
  if (entry.ctx.showReasoning) {
    if (ev.redacted || (ev.signed && !ev.text)) {
      step.thought = noSummaryThought().text;
    } else if (ev.text) {
      const resolved = resolveReasoningThought(ev.text.slice(0, MAX_REASONING_CAPTURE));
      if (resolved.kind !== "none") step.thought = resolved.text;
    }
  }
  // Pure-thinking turn does not send a first card; only refresh once a card exists.
  if (entry.messageId) scheduleFlush(sessionKey, entry);
}

function onToolStart(sessionKey: string, entry: CardEntry, ev: Extract<AgentStreamEvent, { kind: "tool_start" }>): void {
  endRunningThinking(entry, Date.now());
  entry.phase = "tool";
  entry.steps.push({
    tool: ev.name,
    status: "running",
    startedAt: Date.now(),
    summary: summarizeToolParams(ev.name, ev.input),
    ...(ev.id ? { toolCallId: ev.id } : {}),
  });
  trimSteps(entry);
  scheduleFlush(sessionKey, entry);
}

function onToolEnd(sessionKey: string, entry: CardEntry, ev: Extract<AgentStreamEvent, { kind: "tool_end" }>): void {
  let target: CardStep | undefined;
  if (ev.id) {
    target = entry.steps.find((s) => s.toolCallId === ev.id && s.status === "running");
  } else {
    for (let i = entry.steps.length - 1; i >= 0; i--) {
      const s = entry.steps[i];
      if (s.tool !== THINKING_TOOL && s.status === "running") { target = s; break; }
    }
  }
  if (target) {
    target.status = ev.isError ? "error" : "done";
    if (typeof target.startedAt === "number") {
      target.durationMs = Math.max(0, Date.now() - target.startedAt);
    }
  }
  scheduleFlush(sessionKey, entry);
}

function onAnswering(sessionKey: string, entry: CardEntry): void {
  if (entry.phase === "stopped" || entry.phase === "error") return;
  endRunningThinking(entry, Date.now());
  entry.phase = "answering";
  // Only refresh a card that already exists; a pure-text answer needs no card.
  if (entry.messageId || hasRealStep(entry)) scheduleFlush(sessionKey, entry);
}

/**
 * A non-success SDK result (error_max_turns, error, …) drives the card's terminal
 * to "error" rather than the default "done": {@link finalizeCard} reads this phase
 * so a tool-failed turn is never mislabeled complete. The subtype is stashed for
 * the error frame's text.
 */
function onResult(entry: CardEntry, ev: Extract<AgentStreamEvent, { kind: "result" }>): void {
  if (!ev.isError || entry.phase === "stopped") return;
  entry.phase = "error";
  if (!entry.terminalError && ev.subtype) entry.terminalError = ev.subtype;
  // Terminal frame is emitted by finalizeCard (called by the dispatcher immediately
  // after the stream ends); no flush is scheduled here.
}

/**
 * Feed one SDK stream event into the state machine. Fenced to the handle's turn
 * generation: a no-op when the entry is stale/skipped (a superseding turn owns the
 * card) or the turn has been marked stopped (intake is frozen so the card settles).
 * `text` steps also record startedAt at tool_start so tool_end can compute a
 * duration (the SDK gives no per-tool duration).
 */
export function handleAgentEvent(handle: CardHandle, event: AgentStreamEvent): void {
  const entry = entryFor(handle);
  if (!entry || entry.skip || entry.stopped) return;
  const sessionKey = handle.sessionKey;
  switch (event.kind) {
    case "thinking":
      onThinking(sessionKey, entry, event);
      break;
    case "tool_start":
      // Stamp startedAt so tool_end can derive a duration.
      onToolStart(sessionKey, entry, event);
      break;
    case "tool_end":
      onToolEnd(sessionKey, entry, event);
      break;
    case "text":
      onAnswering(sessionKey, entry);
      break;
    case "result":
      onResult(entry, event);
      break;
  }
}

// ─── Finalize ─────────────────────────────────────────────────────────────────

/**
 * Dispatch teardown: settle the card into its terminal frame. Idempotent and
 * fail-closed. Fenced to the handle's turn generation — a superseded turn's
 * finalize (e.g. from a handler still running after a dispatch timeout) no-ops
 * against the new turn's card. A turn that never sent a card and did no visible
 * tool work leaves nothing behind.
 *
 * The terminal frame goes through the SAME flush path (and thus the SAME 429
 * cooldown) as mid-frames: if a cooldown is open it is held and flushed once the
 * window clears (and retried, not dropped, on a further 429) rather than bypassing
 * the window with an immediate append.
 */
export async function finalizeCard(
  handle: CardHandle,
  opts: { success: boolean; errorText?: string } = { success: true },
): Promise<void> {
  const entry = entryFor(handle);
  if (!entry) return;
  const sessionKey = handle.sessionKey;
  // Let the in-flight mid-frame flush land first so the terminal frame is strictly last.
  if (entry.flushPromise) {
    try { await entry.flushPromise; } catch { /* runFlush already warned */ }
  }
  endRunningThinking(entry, Date.now());

  // Disabled session (deterministic 4xx earlier): drop it, emit nothing.
  if (entry.skip) {
    if (cards.get(sessionKey) === entry) cards.delete(sessionKey);
    return;
  }

  const errored = entry.phase === "error" || !opts.success || !!opts.errorText;
  const terminalPhase: CardProgressState["phase"] = entry.stopped || entry.phase === "stopped"
    ? "stopped"
    : errored ? "error" : "done";
  const errorText = opts.errorText ?? (errored ? entry.terminalError : undefined);

  // Nothing sent yet and no tool work worth showing: stay silent (the text answer
  // stands alone). A pure-text / pure-thinking turn leaves no card.
  if (!entry.messageId && !hasRealStep(entry)) {
    if (cards.get(sessionKey) === entry) cards.delete(sessionKey);
    return;
  }

  // Detach and drain on the independent terminal lifecycle: deliverTerminal sends now
  // when clear, or holds + retries across the 429 window — and a superseding turn can
  // no longer cancel it.
  beginTerminal(entry, sessionKey, terminalPhase, errorText);
  await deliverTerminal(entry);
}

/**
 * Mark the turn as aborted (user stop / dispatch timeout) so the card settles as
 * "stopped". Fenced to the handle's generation and STICKY (freezes further intake so
 * a background stream can't flip the card back off "stopped"). Terminalizes on the
 * SAME independent lifecycle as {@link finalizeCard}: the stopped frame is detached
 * from the session map, so an immediate retry (a new turn on this session) cannot
 * cancel it, and the still-running handler's later finalizeCard(handle) no-ops
 * (the entry is no longer in the map under this generation).
 */
export function markStopped(handle: CardHandle): void {
  const entry = entryFor(handle);
  if (!entry || entry.skip || entry.stopped) return;
  endRunningThinking(entry, Date.now());
  entry.phase = "stopped";
  entry.stopped = true;
  beginTerminal(entry, handle.sessionKey, "stopped");
  void deliverTerminal(entry);
}
