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
  messageId?: string;
  phase: CardProgressState["phase"];
  steps: CardStep[];
  startedAt: number;
  dirty: boolean;
  inFlight: boolean;
  skip: boolean;
  flushTimer?: ReturnType<typeof setTimeout>;
  /** In-flight flush promise; finalizeCard awaits it so the terminal frame lands last. */
  flushPromise?: Promise<void>;
  cooldownTimer?: ReturnType<typeof setTimeout>;
  /** Next positive CAS value for an edit. */
  nextCardSeq: number;
}

const FLUSH_DEBOUNCE_MS = 800;
const EDIT_TIMEOUT_MS = 10_000;
/** Fixed cooldown on a 429 — postJson does not surface Retry-After. Progress is discardable. */
const RATE_LIMIT_COOLDOWN_MS = 30_000;
/** Raw thinking text is bounded here before desensitization (which caps display separately). */
const MAX_REASONING_CAPTURE = 4_000;
/** Bound stored steps against a pathologically long run; the renderer caps what is shown. */
const MAX_TRACKED_STEPS = 300;
const THINKING_TOOL = "__thinking__";

/** cc bots are a single identity per config, so a plain module Map suffices. */
const cards = new Map<string, CardEntry>();
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
 * Register the send context at dispatch start. Replaces any prior generation:
 * the old entry's pending timers are cancelled and it is marked skip so a late
 * flush cannot fire against the new turn.
 */
export function setCardContext(sessionKey: string, ctx: ProgressCardContext): void {
  if (!sessionKey) return;
  const existing = cards.get(sessionKey);
  if (existing) {
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    clearCooldownTimer(existing);
    existing.skip = true;
  }
  cards.set(sessionKey, {
    ctx,
    phase: "thinking",
    steps: [],
    startedAt: Date.now(),
    dirty: false,
    inFlight: false,
    skip: false,
    nextCardSeq: 1,
  });
}

/** Hard cleanup (no terminal frame). Used for abnormal teardown. */
export function clearCard(sessionKey: string): void {
  const entry = cards.get(sessionKey);
  if (entry) {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    clearCooldownTimer(entry);
    entry.skip = true;
  }
  cards.delete(sessionKey);
}

/** Test helper: drop all state. */
export function _resetProgressCardsForTests(): void {
  for (const entry of cards.values()) {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    clearCooldownTimer(entry);
    entry.skip = true;
  }
  cards.clear();
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
    if (entry.dirty && !entry.skip && cards.get(sessionKey) === entry &&
        cooldownRemainingMs(entry.ctx.apiUrl) === 0) {
      scheduleFlush(sessionKey, entry);
    }
  }
}

async function runFlush(sessionKey: string, entry: CardEntry): Promise<void> {
  entry.dirty = false;
  const signal = AbortSignal.timeout(EDIT_TIMEOUT_MS);
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
      if (!isCurrentEntry(sessionKey, entry)) return;
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
 * Feed one SDK stream event into the state machine. Safe to call for any session;
 * a no-op when no card context is registered or the entry is stale/skipped.
 * `text` steps also record startedAt at tool_start so tool_end can compute a
 * duration (the SDK gives no per-tool duration).
 */
export function handleAgentEvent(sessionKey: string, event: AgentStreamEvent): void {
  const entry = cards.get(sessionKey);
  if (!entry || entry.skip) return;
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
      // The turn-level finalizeCard (called by the dispatcher) owns the terminal
      // frame; nothing to do here beyond what tool_end/text already captured.
      break;
  }
}

// ─── Finalize ─────────────────────────────────────────────────────────────────

/**
 * Dispatch teardown: settle the card into its terminal frame. Idempotent and
 * fail-closed. A turn that never sent a card (pure text / pure thinking / debounce
 * never fired without real steps) leaves nothing behind.
 */
export async function finalizeCard(
  sessionKey: string,
  opts: { success: boolean; errorText?: string } = { success: true },
): Promise<void> {
  const entry = cards.get(sessionKey);
  if (!entry) return;
  // Let the in-flight flush land first so the terminal frame is strictly last.
  if (entry.flushPromise) {
    try { await entry.flushPromise; } catch { /* runFlush already warned */ }
  }
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = undefined;
  }
  clearCooldownTimer(entry);
  endRunningThinking(entry, Date.now());

  // Only settle the current generation; a superseding turn owns its own card.
  if (cards.get(sessionKey) === entry) cards.delete(sessionKey);
  if (entry.skip) return;

  const terminalPhase: CardProgressState["phase"] = entry.phase === "stopped"
    ? "stopped"
    : opts.success && !opts.errorText ? "done" : "error";
  const state = progressState(entry, terminalPhase, opts.errorText);

  // Nothing sent yet: only emit a terminal card when the turn actually did tool
  // work worth showing. Otherwise stay silent (the text answer stands alone).
  if (!entry.messageId) {
    if (!hasRealStep(entry)) return;
    if (cooldownRemainingMs(entry.ctx.apiUrl) > 0) return;
    const { card, plain } = renderProgressCard(state, entry.ctx.caps);
    try {
      await sendCardMessage({
        apiUrl: entry.ctx.apiUrl,
        botToken: entry.ctx.botToken,
        channelId: entry.ctx.channelId,
        channelType: entry.ctx.channelType,
        card,
        plain,
        signal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
      });
    } catch (err) {
      warn(`terminal card send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const { card, plain } = renderProgressCard(state, entry.ctx.caps);
  try {
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
      signal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
    });
  } catch (err) {
    warn(`finalize edit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Mark the turn as user-aborted so the terminal frame renders as "stopped". */
export function markStopped(sessionKey: string): void {
  const entry = cards.get(sessionKey);
  if (!entry || entry.skip) return;
  endRunningThinking(entry, Date.now());
  entry.phase = "stopped";
}
