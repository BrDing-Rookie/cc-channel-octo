/**
 * A4/A8: card-session store — registration, claim/duplicate, per-event replay
 * attempt counting (dead-letter budget), release/complete, and TTL/LRU eviction.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  registerCardSession,
  lookupCardSession,
  claimCardSession,
  releaseCardSessionClaim,
  completeCardSession,
  nextCardSessionSeq,
  _resetCardSessionsForTests,
  type CardSession,
} from '../card-session.js';
import { ChannelType } from '../octo/types.js';

function session(over: Partial<CardSession> = {}): CardSession {
  return {
    accountId: 'bot-1',
    channelId: 'grp-9',
    channelType: ChannelType.Group,
    title: 'T',
    card: { type: 'AdaptiveCard' },
    plain: 'T',
    actionLabels: { yes: 'Yes' },
    inputIds: [],
    ...over,
  };
}

describe('card-session', () => {
  beforeEach(() => _resetCardSessionsForTests());
  afterEach(() => vi.useRealTimers());

  it('registers and looks up a session by message id', () => {
    registerCardSession('m1', session());
    expect(lookupCardSession('m1')?.channelId).toBe('grp-9');
    expect(lookupCardSession('nope')).toBeNull();
  });

  it('claims a pending session once; a second claim is a duplicate', () => {
    registerCardSession('m1', session());
    const first = claimCardSession('m1', 100);
    expect(first.status).toBe('claimed');
    const second = claimCardSession('m1', 100);
    expect(second.status).toBe('duplicate');
  });

  it('counts attempts per event id (dead-letter budget) and resets on a new event', () => {
    registerCardSession('m1', session());
    // Same event id replayed after release accumulates attempts.
    for (let i = 1; i <= 3; i++) {
      const c = claimCardSession('m1', 100);
      expect(c.status).toBe('claimed');
      if (c.status === 'claimed') expect(c.attempts).toBe(i);
      releaseCardSessionClaim('m1', 100);
    }
    // A genuinely new click (new event id) resets the counter.
    const fresh = claimCardSession('m1', 200);
    expect(fresh.status === 'claimed' && fresh.attempts).toBe(1);
  });

  it('release returns a claim to pending; complete freezes it', () => {
    registerCardSession('m1', session());
    claimCardSession('m1', 1);
    releaseCardSessionClaim('m1', 1);
    expect(claimCardSession('m1', 2).status).toBe('claimed'); // claimable again
    completeCardSession('m1', 2);
    expect(claimCardSession('m1', 3).status).toBe('duplicate'); // frozen
  });

  it('nextCardSessionSeq is monotonic and undefined for an unknown message', () => {
    registerCardSession('m1', session());
    expect(nextCardSessionSeq('m1')).toBe(1);
    expect(nextCardSessionSeq('m1')).toBe(2);
    expect(nextCardSessionSeq('nope')).toBeUndefined();
  });

  it('expires a session past its 24h TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    registerCardSession('m1', session());
    vi.setSystemTime(new Date('2026-01-02T00:00:01Z')); // > 24h later
    expect(lookupCardSession('m1')).toBeNull();
  });
});
