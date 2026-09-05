/**
 * A8 inbound transport: the /v1/bot/events poll loop. Verifies card_action routing,
 * cursor-advance + ack on a recognized event, and the deliberate replay semantics
 * of a throwing handler (cursor NOT advanced, event NOT ack'd → re-fetched).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../octo/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../octo/api.js')>();
  return { ...actual, fetchBotEvents: vi.fn(), ackBotEvent: vi.fn().mockResolvedValue(undefined) };
});

import { startEventPoller, type EventCursorStore } from '../card-events-poll.js';
import { fetchBotEvents, ackBotEvent } from '../octo/api.js';
import { ChannelType, type BotEvent } from '../octo/types.js';
import type { CardAction } from '../card-action.js';

const mockFetch = vi.mocked(fetchBotEvents);
const mockAck = vi.mocked(ackBotEvent);

function memoryCursor(): EventCursorStore & { saved: number[] } {
  const saved: number[] = [];
  return { saved, load: async () => 0, save: async (id: number) => { saved.push(id); } };
}

function cardEvent(id: number): BotEvent {
  return {
    event_id: id,
    event_type: 'card_action',
    event_data: { message_id: 'm1', channel_id: 'grp-9', channel_type: ChannelType.Group, action_id: 'yes', operator_uid: 'u1' },
  };
}

const WIRE = { apiUrl: 'https://octo.example.com', botToken: 'tok' };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('startEventPoller', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockAck.mockReset();
    mockAck.mockResolvedValue(undefined);
  });

  it('routes a card_action, advances the cursor, and acks it', async () => {
    const cursor = memoryCursor();
    const got: CardAction[] = [];
    const ackDone = deferred<void>();
    mockAck.mockImplementation(async () => { ackDone.resolve(); });
    mockFetch.mockImplementation(async () => (mockFetch.mock.calls.length === 1 ? [cardEvent(42)] : []));

    const poller = startEventPoller({
      ...WIRE,
      cursorStore: cursor,
      intervalMs: 500,
      onCardAction: async (a) => { got.push(a); },
    });
    await ackDone.promise;
    poller.stop();

    expect(got).toHaveLength(1);
    expect(got[0].messageId).toBe('m1');
    expect(cursor.saved).toContain(42);
    expect(mockAck).toHaveBeenCalledWith(expect.objectContaining({ eventId: 42 }));
    expect(poller.cursor()).toBe(42);
  });

  it('a throwing handler is replayed: no cursor advance, no ack, event re-fetched', async () => {
    const cursor = memoryCursor();
    const secondFetch = deferred<void>();
    let calls = 0;
    mockFetch.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) secondFetch.resolve();
      return calls <= 2 ? [cardEvent(42)] : [];
    });

    const poller = startEventPoller({
      ...WIRE,
      cursorStore: cursor,
      intervalMs: 500,
      onCardAction: async () => { throw new Error('boom'); },
    });
    await secondFetch.promise; // the same event was fetched again (replay)
    poller.stop();

    expect(cursor.saved).not.toContain(42); // cursor never advanced past the failing event
    expect(mockAck).not.toHaveBeenCalled(); // never ack an event we did not process
  });

  it('advances the cursor for an unrecognized event but does not ack it', async () => {
    const cursor = memoryCursor();
    const done = deferred<void>();
    mockFetch.mockImplementation(async () => {
      if (mockFetch.mock.calls.length === 1) return [{ event_id: 9, event_type: 'bot_setting_updated', event_data: {} }];
      done.resolve();
      return [];
    });
    const poller = startEventPoller({ ...WIRE, cursorStore: cursor, intervalMs: 500, onCardAction: async () => {} });
    await done.promise;
    poller.stop();
    expect(cursor.saved).toContain(9); // consumer advances so it stops re-fetching
    expect(mockAck).not.toHaveBeenCalled(); // but does not ack an event it did not handle
  });
});
