/**
 * A4/A8: interactive-card session store — the ONE model both the send tool (A4,
 * `card-interactive-tool.ts`) and the action callback handler (A8,
 * `card-action-handler.ts`) share.
 *
 * A4 registers a session keyed by the sent card's `message_id` when it posts an
 * interactive card; A8 looks that session up when a `card_action` callback lands,
 * reads it to verify the click's identity + ownership (account + channel), writes
 * status frames back to the same card, and bounds poison-pill replay via the
 * per-event `dispatchAttempts` counter.
 *
 * The store is an in-memory, process-local map with a 24h TTL and an LRU cap — a
 * card older than the TTL, or evicted under load, degrades gracefully: a late
 * click on it is treated as "unknown/expired" and ignored (A8), never crashes.
 * There is no cross-process/persistent card state by design: an interactive card
 * is a short-lived confirmation/approval, not durable data.
 *
 * Ported from openclaw-channel-octo src/card-session.ts. cc is single-bot per
 * process, so `accountId` is the bot's own id (there is no multi-account layer);
 * the account axis of the A8 identity check still guards against a stale click
 * arriving after a bot-id/token rotation.
 */

import { requestCardEventPolling } from './card-events-poll.js';
import type { ChannelType } from './octo/types.js';

export interface CardSession {
  /** Session key of the turn that authored the card (for the A8 turn re-run + logging). */
  sessionKey?: string;
  /** Owning bot id (cc is single-bot per process; used by the A8 identity check). */
  accountId: string;
  channelId: string;
  channelType: ChannelType;
  title: string;
  card: Record<string, unknown>;
  plain: string;
  /** actionId → sanitized button label, for status-frame rendering + the known-action gate. */
  actionLabels: Record<string, string>;
  /** Whitelisted input ids the callback's submitted values are validated against. */
  inputIds: string[];
  maxInputTextBytes?: number;
  maxInputsBytes?: number;
}

interface CardSessionEntry {
  session: CardSession;
  expiresAt: number;
  state: 'pending' | 'processing' | 'completed';
  claimedEventId?: number;
  cardSeq: number;
  /** Number of dispatch attempts for the current `attemptEventId`; bounds poison-pill replay. */
  dispatchAttempts: number;
  /** The event id `dispatchAttempts` is counting; a new event id resets the counter. */
  attemptEventId?: number;
}

export type CardClaimResult =
  | { status: 'claimed'; session: CardSession; attempts: number }
  | { status: 'duplicate'; session: CardSession }
  | { status: 'missing' };

const CARD_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CARD_SESSIONS = 1_000;
const sessions = new Map<string, CardSessionEntry>();

function pruneExpired(now = Date.now()): void {
  for (const [messageId, entry] of sessions) {
    if (entry.expiresAt <= now) sessions.delete(messageId);
  }
}

function entryFor(messageId: string): CardSessionEntry | null {
  const entry = sessions.get(messageId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sessions.delete(messageId);
    return null;
  }
  return entry;
}

export function registerCardSession(messageId: string, session: CardSession): void {
  if (!messageId.trim()) return;
  pruneExpired();
  if (sessions.has(messageId)) sessions.delete(messageId);
  while (sessions.size >= MAX_CARD_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (!oldest) break;
    sessions.delete(oldest);
  }
  sessions.set(messageId, {
    session,
    expiresAt: Date.now() + CARD_SESSION_TTL_MS,
    state: 'pending',
    cardSeq: 0,
    dispatchAttempts: 0,
  });
  // Registering an interactive card means a click can now arrive: make sure the
  // owning bot's event poll loop is running so the callback is actually fetched.
  requestCardEventPolling(session.accountId);
}

export function lookupCardSession(messageId: string): CardSession | null {
  return entryFor(messageId)?.session ?? null;
}

export function claimCardSession(messageId: string, eventId: number): CardClaimResult {
  const entry = entryFor(messageId);
  if (!entry) return { status: 'missing' };
  if (entry.state !== 'pending') return { status: 'duplicate', session: entry.session };
  entry.state = 'processing';
  entry.claimedEventId = eventId;
  // Count attempts per event id: replays of the same event (poller re-fetches the
  // same id while the cursor is stuck) accumulate; a genuinely new click resets.
  if (entry.attemptEventId !== eventId) {
    entry.attemptEventId = eventId;
    entry.dispatchAttempts = 0;
  }
  entry.dispatchAttempts += 1;
  return { status: 'claimed', session: entry.session, attempts: entry.dispatchAttempts };
}

export function releaseCardSessionClaim(messageId: string, eventId: number): void {
  const entry = entryFor(messageId);
  if (!entry || entry.state !== 'processing' || entry.claimedEventId !== eventId) return;
  entry.state = 'pending';
  entry.claimedEventId = undefined;
}

export function completeCardSession(messageId: string, eventId: number): void {
  const entry = entryFor(messageId);
  if (!entry || entry.state !== 'processing' || entry.claimedEventId !== eventId) return;
  entry.state = 'completed';
}

export function nextCardSessionSeq(messageId: string): number | undefined {
  const entry = entryFor(messageId);
  if (!entry) return undefined;
  entry.cardSeq += 1;
  return entry.cardSeq;
}

export function forgetCardSession(messageId: string): void {
  sessions.delete(messageId);
}

export function _resetCardSessionsForTests(): void {
  sessions.clear();
}
