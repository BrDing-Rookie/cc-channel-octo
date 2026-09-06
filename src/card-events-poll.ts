/**
 * A8 inbound transport: the non-overlapping /v1/bot/events poll loop that delivers
 * `card_action` callbacks to the A8 handler (`card-action-handler.ts`).
 *
 * Ported from openclaw-channel-octo src/events-poll.ts, trimmed to what this batch
 * needs: the wire endpoints (`fetchBotEvents` / `ackBotEvent`) landed with batch 0,
 * but nothing consumed them yet, so an interactive card's click had no way in. This
 * loop is that missing consumer. Doc-comment mentions (D1) and the reasoning card
 * profile-cache invalidation are NOT ported here — cc has neither yet — so this
 * routes exactly one event type: `card_action`.
 *
 * The loop is lazy: it starts only once an interactive card has been registered
 * (`card-session.ts` → `requestCardEventPolling`), so a bot that never sends an
 * interactive card issues zero events traffic. It short-polls by default and
 * long-polls when `waitSeconds` is set.
 *
 * Two load-bearing invariants (see the inline notes — do not collapse them):
 * 1. Cursor persistence is attempted BEFORE ack, so a crash can at worst replay an
 *    action; it can never ack an event it has already forgotten locally.
 * 2. card_action deliberately lets a handler *throw* escape: the cursor is NOT
 *    advanced and NOT ack'd, so the poller re-fetches the same id next tick. Replay
 *    is bounded by the per-event dispatchAttempts counter in card-session.ts, so a
 *    poison-pill click cannot loop forever.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ackBotEvent,
  eventsPollTimeoutMs,
  fetchBotEvents,
  MAX_EVENT_WAIT_SECONDS,
  MIN_EVENT_WAIT_SECONDS,
} from './octo/api.js';
import { parseCardAction, type CardAction } from './card-action.js';
import { parseDocCommentMention, type DocCommentMention } from './doc-mention.js';

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_LIMIT = 50;
/** Ceiling for the error backoff in long-poll mode. */
const MAX_ERROR_BACKOFF_MS = 30_000;
/**
 * How much of the requested hold a response must have consumed for the server to count as
 * "actually holding". Well below 1 so ordinary jitter, or a hold ended early by a real event
 * arriving, is not mistaken for a non-holding server.
 */
const HELD_FRACTION = 0.5;

export interface EventCursorStore {
  load(): Promise<number>;
  save(eventId: number): Promise<void>;
}

/**
 * File-backed cursor store. `dir` is the bot's per-bot dataDir (cc keeps all
 * per-bot durable state there); the cursor lives in `events.cursor.json`.
 */
export function createFileEventCursorStore(params: { dir: string }): EventCursorStore {
  const dir = params.dir;
  const file = join(dir, 'events.cursor.json');
  return {
    async load(): Promise<number> {
      try {
        const raw = JSON.parse(await readFile(file, 'utf8')) as { event_id?: unknown };
        return typeof raw.event_id === 'number' && Number.isSafeInteger(raw.event_id) && raw.event_id >= 0
          ? raw.event_id
          : 0;
      } catch {
        return 0;
      }
    },
    async save(eventId: number): Promise<void> {
      if (!Number.isSafeInteger(eventId) || eventId < 0) {
        throw new Error(`invalid event cursor: ${eventId}`);
      }
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.events.cursor.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(tmp, `${JSON.stringify({ event_id: eventId })}\n`, 'utf8');
      await rename(tmp, file);
    },
  };
}

export interface EventPollerOptions {
  apiUrl: string;
  botToken: string;
  cursorStore: EventCursorStore;
  onCardAction?: (action: CardAction) => void | Promise<void>;
  /**
   * D1: routed a `doc_comment_mention` event. Like `onCardAction`, awaited
   * serially and allowed to throw (cursor not advanced/acked → bounded replay);
   * in practice the doc-mention handler never throws (it owns its own dedupe /
   * dead-letter), so a resolved call is safe to ack.
   */
  onDocMention?: (mention: DocCommentMention) => void | Promise<void>;
  intervalMs?: number;
  limit?: number;
  /**
   * Seconds to let the server hold an empty queue open (its `wait` parameter).
   *
   * Unset or 0 keeps the historical short-poll loop: one read per `intervalMs`. When set, the
   * server supplies the pacing — it only answers early once an event lands — so the loop stops
   * adding `intervalMs` of dead time between reads, which would otherwise eat much of the
   * latency the hold just bought.
   */
  waitSeconds?: number;
  ack?: boolean;
  log?: { info?: (message: string) => void; error?: (message: string) => void };
}

export interface EventPoller {
  ready: Promise<void>;
  stop(): void;
  cursor(): number;
}

function normalizeAccountId(value: string): string {
  return value.trim();
}

const POLL_STARTERS_STATE_KEY = Symbol.for('cc-channel-octo.card-event-poll-starters.v1');

function getPollStarters(): Map<string, () => void> {
  const root = process as unknown as Record<PropertyKey, unknown>;
  const existing = root[POLL_STARTERS_STATE_KEY] as Map<string, () => void> | undefined;
  if (existing) return existing;
  const created = new Map<string, () => void>();
  root[POLL_STARTERS_STATE_KEY] = created;
  return created;
}

// Card session store and the bot runtime may load separate module instances. Keep the lazy
// starters process-shared so registering a card always activates the owning bot's poller.
const pollStarters = getPollStarters();

export function setCardEventPollStarter(accountId: string, starter: (() => void) | undefined): void {
  const id = normalizeAccountId(accountId);
  if (starter) pollStarters.set(id, starter);
  else pollStarters.delete(id);
}

export function requestCardEventPolling(accountId: string): void {
  pollStarters.get(normalizeAccountId(accountId))?.();
}

export function _resetCardEventPollStartersForTests(): void {
  pollStarters.clear();
}

/**
 * Start one non-overlapping poll loop, short-polling by default and long-polling when
 * `waitSeconds` is set.
 */
export function startEventPoller(options: EventPollerOptions): EventPoller {
  const intervalMs = Math.max(500, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS));
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  // Clamp at runtime, not just in config: a host that surfaces the range advisorily would
  // otherwise let waitSeconds: 3600 through, yielding a ~3610s client timeout against a server
  // that clamps its own `wait` to 30s. The lower bound matters too: a hold shorter than
  // MIN_EVENT_WAIT_SECONDS makes idle traffic worse than the short polling it replaces and
  // narrows the "did the server hold?" guard below a normal slow RTT. Raise rather than reject.
  const requestedWait = options.waitSeconds ?? 0;
  const waitSeconds =
    requestedWait > 0
      ? Math.min(MAX_EVENT_WAIT_SECONDS, Math.max(MIN_EVENT_WAIT_SECONDS, Math.round(requestedWait)))
      : 0;
  if (requestedWait > 0 && waitSeconds !== Math.round(requestedWait)) {
    options.log?.info?.(
      `octo: eventWaitSeconds ${requestedWait} clamped to ${waitSeconds} ` +
        `(valid range ${MIN_EVENT_WAIT_SECONDS}-${MAX_EVENT_WAIT_SECONDS}; 0 disables long polling)`,
    );
  }
  let cursor = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Tracks the in-flight request so stop() can cut a hold short. Without this the loop is a
  // single sequential chain, so a stop during a 25s hold would keep the account busy for the
  // rest of that hold instead of shutting down.
  let inFlight: AbortController | undefined;
  let consecutiveErrors = 0;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), Math.max(0, delayMs));
  };

  /**
   * Pace the next tick from what this one actually did. Only a hold that was genuinely honoured
   * earns an immediate re-poll; a fast return (old server ignoring `wait`, a 4xx/5xx, a proxy
   * closing the hold early) must NOT re-fire immediately or the loop becomes a hot loop.
   */
  const nextDelayMs = (outcome: 'batch' | 'empty' | 'error', requestMs: number): number => {
    if (outcome === 'error') {
      // Never hammer an unhealthy server. Exponential, capped, reset on any success.
      consecutiveErrors += 1;
      return Math.min(MAX_ERROR_BACKOFF_MS, intervalMs * 2 ** (consecutiveErrors - 1));
    }
    consecutiveErrors = 0;
    if (waitSeconds === 0) return intervalMs; // short poll: success pacing unchanged
    // Events in hand: drain immediately, there may be more behind them.
    if (outcome === 'batch') return 0;
    // Empty, and the server clearly did not hold for anything like the time we asked for — fall
    // back to client-side pacing rather than spinning.
    if (requestMs < waitSeconds * 1000 * HELD_FRACTION) return intervalMs;
    // Empty after a real hold: the server did its job, go straight back in.
    return 0;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const startedAt = Date.now();
    let outcome: 'batch' | 'empty' | 'error' = 'empty';
    try {
      const controller = new AbortController();
      inFlight = controller;
      const timeoutSignal = AbortSignal.timeout(eventsPollTimeoutMs(waitSeconds));
      const events = await fetchBotEvents({
        apiUrl: options.apiUrl,
        botToken: options.botToken,
        sinceEventId: cursor,
        limit,
        ...(waitSeconds > 0 ? { waitSeconds } : {}),
        // Combine both reasons to give up: the ordinary per-request timeout, and an explicit stop.
        signal: AbortSignal.any([controller.signal, timeoutSignal]),
      });
      // Validate ids *before* sorting: a non-integer event_id makes numeric-subtraction comparison
      // return NaN, which leaves the sort order unspecified and can drop a valid interleaved event.
      const malformed = events.filter((event) => !Number.isSafeInteger(event.event_id)).length;
      if (malformed > 0) {
        options.log?.error?.(`octo: event poll dropped ${malformed} event(s) with a non-integer event_id`);
      }
      let cardActions = 0;
      let docMentions = 0;
      const ordered = events
        .filter((event) => Number.isSafeInteger(event.event_id) && event.event_id > cursor)
        .sort((a, b) => a.event_id - b.event_id);
      for (const event of ordered) {
        // 已识别的事件才 ack。未识别的只推进游标(本消费者不再重复拉取),留在服务端直至过期。
        let recognized = false;
        const action = options.onCardAction ? parseCardAction(event) : null;
        if (action) {
          recognized = true;
          cardActions += 1;
          // 卡片动作**故意**让异常逃出去:不存游标、不 ack,下一轮重取同一事件。重放次数由
          // card-session 的 per-event dispatchAttempts 计数封顶,不会无限循环。
          await options.onCardAction!(action);
        }

        // D1 doc-comment mention. Mutually exclusive with card_action (distinct
        // event_type), so a card event never parses here and vice versa. Awaited
        // serially — a doc task edits a document, so overlapping runs on the same
        // thread must not race (see doc-mention.ts / dedupe rationale).
        if (!recognized && options.onDocMention) {
          const mention = parseDocCommentMention(event);
          if (mention) {
            recognized = true;
            docMentions += 1;
            await options.onDocMention(mention);
          }
        }

        // 落盘游标**排在 ack 之前**:进程崩溃最坏是重放一次动作,绝不会 ack 掉一个本地已经忘掉
        // 的事件。落盘**不许抛**:失败只记日志,内存游标照常前进,ack 照常执行 —— 否则一次写盘
        // 失败会楔死整个批次,把动作每 tick 重取一遍。
        try {
          await options.cursorStore.save(event.event_id);
        } catch (error) {
          options.log?.error?.(
            `octo: cursor save failed at event ${event.event_id} (in-memory cursor still advances): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        cursor = event.event_id;

        // 只 ack 自己识别并处理过的事件。
        if (recognized && options.ack !== false) {
          try {
            await ackBotEvent({
              apiUrl: options.apiUrl,
              botToken: options.botToken,
              eventId: event.event_id,
            });
          } catch (error) {
            options.log?.error?.(
              `octo: ack event ${event.event_id} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      // Classify from forward progress, not response size: a non-empty but entirely undrainable
      // response (ids outside the safe range, or a persisted cursor ahead of the server) must fall
      // through to "empty" and be paced by intervalMs, not re-fire at 0ms forever.
      outcome = ordered.length > 0 ? 'batch' : 'empty';
      if (events.length > 0) {
        options.log?.info?.(
          `octo: event poll batch events=${events.length} card_actions=${cardActions} doc_mentions=${docMentions} cursor=${cursor}`,
        );
      }
    } catch (error) {
      outcome = 'error';
      // A stop() mid-hold aborts the request on purpose; reporting that as a poll failure would
      // put a spurious error in the log on every clean shutdown.
      if (!stopped) {
        options.log?.error?.(
          `octo: event poll failed at cursor=${cursor}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      inFlight = undefined;
      schedule(nextDelayMs(outcome, Date.now() - startedAt));
    }
  };

  const ready = options.cursorStore
    .load()
    .then((loaded) => {
      cursor = Number.isSafeInteger(loaded) && loaded >= 0 ? loaded : 0;
      options.log?.info?.(`octo: bot event poller ready at cursor=${cursor}`);
      // First tick keeps openclaw's timing: short polling waits one interval before its first
      // read, long polling starts immediately.
      schedule(waitSeconds > 0 ? 0 : intervalMs);
    })
    .catch((error) => {
      options.log?.error?.(
        `octo: event cursor load failed, starting from zero: ${error instanceof Error ? error.message : String(error)}`,
      );
      cursor = 0;
      schedule(waitSeconds > 0 ? 0 : intervalMs);
    });

  return {
    ready,
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Cut a hold short rather than waiting it out. Set `stopped` first so the abort is
      // classified as a shutdown, not a poll failure.
      inFlight?.abort();
    },
    cursor(): number {
      return cursor;
    },
  };
}
