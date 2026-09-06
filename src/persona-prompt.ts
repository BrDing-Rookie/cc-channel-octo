/**
 * E1: persona_prompt cache + composer (openclaw parity, adapted to cc).
 *
 * A persona clone (a bot whose config sets `onBehalfOf: <grantor_uid>`) is
 * granted a free-form `persona_prompt` by its grantor. That prompt must reach
 * the bot's LLM system prompt so the bot replies in the grantor's voice.
 *
 * This module owns the active-pull path:
 *   - on bot start, fetch `GET /v1/bot/obo-grant` once (via {@link getBotOboGrant});
 *   - refresh every `refreshIntervalMs` (default 60s);
 *   - cache the composed hint, keyed by the bot's stable `botId`, surfaced via
 *     {@link getPersonaPromptForSession}.
 *
 * cc injects the hint into the FROZEN system prompt's `append` segment (see
 * agent-bridge.ts `buildSystemPrompt`), NOT via openclaw's `before_prompt_build`
 * hook. The hint is stable turn-to-turn (it changes only when the grant changes,
 * ~60s cadence), so it is prompt-cache-safe — unlike per-turn-variable text it
 * does not invalidate the cached prefix every turn.
 *
 * Unlike openclaw (multi-account-per-process, needing a sessionKey→account
 * heuristic), cc knows exactly which bot handles a turn (`config.botId`), so the
 * cache is a plain per-botId map and the caller reads it directly — no
 * session-guessing / multi-account isolation heuristic is required.
 *
 * 代次守卫 (generation guard): a per-botId counter, bumped on every init/stop, so
 * an in-flight refresh that resolves after a stop/reconfigure detects it was
 * superseded and bails BEFORE writing stale data into the cache. Without it a
 * stop → late-resolve race could resurrect a cleared entry (or overwrite a fresh
 * one after reconfigure).
 */

import { getBotOboGrant, type BotOboGrant } from './octo/api.js';

/** Minimal log surface (defaults to console); injectable for tests. */
export interface PersonaLog {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
let _refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;

interface PersonaCacheEntry {
  /** Composed hint ready to be appended to the LLM system prompt. */
  hint: string | undefined;
  fetchedAt: number;
}

/** Minimal shape this module needs from a bot (kept structural for tests). */
export interface PersonaAccountInput {
  /** Stable bot id — the cache key. */
  botId: string;
  apiUrl: string;
  botToken: string;
  /** Grantor uid — when undefined, persona logic is a no-op (regular bot). */
  onBehalfOf?: string;
}

const _cache = new Map<string, PersonaCacheEntry>();
const _timers = new Map<string, ReturnType<typeof setInterval>>();
const _firstFetchLogged = new Set<string>();
const _generation = new Map<string, number>();

function _bumpGeneration(botId: string): number {
  const next = (_generation.get(botId) ?? 0) + 1;
  _generation.set(botId, next);
  return next;
}
function _currentGeneration(botId: string): number {
  return _generation.get(botId) ?? 0;
}

/** Override the refresh interval (ms). Intended for tests; prod uses 60s. */
export function setPersonaPromptRefreshIntervalMs(ms: number): void {
  if (ms > 0) _refreshIntervalMs = ms;
}

/**
 * Compose the system-prompt hint from a grant payload. Returns undefined when
 * the grant has no usable persona content (no grant / paused / empty prompt /
 * no grantor name). Format mirrors octo-server's fan-out copy shape so a single
 * template covers both routes; the channel-specific origin prefix is omitted
 * here (not available at prompt-build time — the hint is per-bot, not per
 * message).
 */
export function composePersonaHint(grant: BotOboGrant): string | undefined {
  if (!grant.has_grant) return undefined;
  if (grant.active === false) return undefined;
  const prompt = (grant.persona_prompt ?? '').trim();
  if (!prompt) return undefined;
  const grantorName = (grant.grantor_name ?? '').trim() || grant.grantor_uid;
  if (!grantorName) return undefined;
  return `你正在以「${grantorName}」的分身身份运作。请以 ${grantorName} 的身份回复。\n\n${prompt}`;
}

/**
 * Fetch the latest grant once and update the cache. Failures are swallowed
 * (logged) so a transient hiccup never blocks messaging — the next tick retries.
 * Captures the current generation before the fetch; if init/stop bumped it while
 * the fetch was in flight, the post-fetch branches bail out (代次守卫) instead of
 * writing now-stale data.
 */
export async function refreshPersonaPromptCache(
  account: PersonaAccountInput,
  log?: PersonaLog,
): Promise<void> {
  if (!account.onBehalfOf) return;
  const botId = account.botId;
  const myGeneration = _currentGeneration(botId);
  let grant: BotOboGrant | null;
  try {
    grant = await getBotOboGrant({ apiUrl: account.apiUrl, botToken: account.botToken });
  } catch (err) {
    if (_currentGeneration(botId) !== myGeneration) return;
    (log?.warn ?? ((m: string) => console.error(`[cc-channel-octo] ${m}`)))(
      `octo: persona_prompt fetch failed for ${botId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Superseded by a stop/reconfigure while the fetch was outstanding → drop it.
  if (_currentGeneration(botId) !== myGeneration) return;

  const hint = grant ? composePersonaHint(grant) : undefined;
  const prev = _cache.get(botId);
  _cache.set(botId, { hint, fetchedAt: Date.now() });

  const info = log?.info ?? ((m: string) => console.error(`[cc-channel-octo] ${m}`));
  if (!_firstFetchLogged.has(botId)) {
    _firstFetchLogged.add(botId);
    if (hint) {
      info(`octo: persona_prompt loaded for ${botId} (grantor=${account.onBehalfOf}, ${hint.length} chars)`);
    } else {
      info(`octo: persona_prompt not active for ${botId} (grantor=${account.onBehalfOf}); will retry every ${_refreshIntervalMs}ms`);
    }
    return;
  }
  if (prev?.hint !== hint) {
    info(`octo: persona_prompt refreshed for ${botId} (hasHint=${Boolean(hint)})`);
  }
}

/**
 * Start the per-bot refresh loop. Idempotent — a repeat call resets the timer.
 * No-op (with teardown of any prior state) when `onBehalfOf` is unset, so the
 * bot start path can call it unconditionally: a bot reconfigured from persona
 * clone back to a plain bot correctly drops its stale hint + timer.
 */
export function initPersonaPromptCache(account: PersonaAccountInput, log?: PersonaLog): void {
  const botId = account.botId;
  if (!account.onBehalfOf) {
    stopPersonaPromptCache(botId);
    return;
  }
  const existing = _timers.get(botId);
  if (existing) clearInterval(existing);

  // Bump generation so any in-flight fetch from a prior cycle bails on resolve.
  _bumpGeneration(botId);
  // Clear eagerly so the reader fails safe (no hint) during the refetch window
  // rather than leaking a stale grantor's identity after a reconfigure.
  _cache.delete(botId);
  _firstFetchLogged.delete(botId);

  void refreshPersonaPromptCache(account, log);

  const timer = setInterval(() => {
    void refreshPersonaPromptCache(account, log);
  }, _refreshIntervalMs);
  timer.unref?.();
  _timers.set(botId, timer);
}

/** Stop the refresh loop and clear cached state for a bot (shutdown / reconfigure). */
export function stopPersonaPromptCache(botId: string): void {
  // Bump BEFORE clearing so a fetch resolving after this point skips its write.
  _bumpGeneration(botId);
  const timer = _timers.get(botId);
  if (timer) clearInterval(timer);
  _timers.delete(botId);
  _cache.delete(botId);
  _firstFetchLogged.delete(botId);
}

/**
 * Read the composed persona hint for a bot. Returns undefined when the bot is
 * not a persona clone, the initial fetch hasn't completed, or the grant is
 * empty / paused. The caller pushes this into the frozen prompt append segment
 * when truthy.
 */
export function getPersonaPromptForSession(botId: string): string | undefined {
  return _cache.get(botId)?.hint;
}

/** Test helper — fully reset module state between cases. */
export function _resetPersonaPromptCacheForTests(): void {
  for (const timer of _timers.values()) clearInterval(timer);
  _timers.clear();
  _cache.clear();
  _firstFetchLogged.clear();
  _generation.clear();
  _refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;
}
