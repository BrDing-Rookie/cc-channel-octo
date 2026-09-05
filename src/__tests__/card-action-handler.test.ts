/**
 * A8: card-action handler orchestration — the security-critical path. Verifies
 * identity + ownership gating, duplicate suppression, input rejection (recoverable),
 * dispatch success/rejection, and the bounded replay → dead-letter budget (≤3).
 *
 * Only the wire edit (editCardMessage) is mocked; the real card-session store and
 * the real input validation run so the invariants are exercised end to end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../octo/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../octo/api.js')>();
  return { ...actual, editCardMessage: vi.fn().mockResolvedValue(undefined) };
});

import { handleCardAction, type CardActionDispatchResult } from '../card-action-handler.js';
import { registerCardSession, claimCardSession, _resetCardSessionsForTests, type CardSession } from '../card-session.js';
import { editCardMessage } from '../octo/api.js';
import { ChannelType } from '../octo/types.js';
import type { CardAction } from '../card-action.js';

const mockEdit = vi.mocked(editCardMessage);

const WIRE = { accountId: 'bot-1', apiUrl: 'https://octo.example.com', botToken: 'tok' };

function session(over: Partial<CardSession> = {}): CardSession {
  return {
    accountId: 'bot-1',
    channelId: 'grp-9',
    channelType: ChannelType.Group,
    title: 'Approve?',
    card: { type: 'AdaptiveCard', body: [], actions: [{ type: 'Action.Submit', id: 'yes' }] },
    plain: 'Approve?\n可选操作：Yes',
    actionLabels: { yes: 'Yes' },
    inputIds: [],
    ...over,
  };
}

function action(over: Partial<CardAction> = {}): CardAction {
  return {
    eventId: 100,
    messageId: 'm1',
    channelId: 'grp-9',
    channelType: ChannelType.Group,
    actionId: 'yes',
    inputs: {},
    operatorUid: 'user-42',
    ...over,
  };
}

describe('handleCardAction', () => {
  beforeEach(() => {
    _resetCardSessionsForTests();
    mockEdit.mockClear();
  });

  it('ignores a click on an unknown/expired card (no dispatch)', async () => {
    const dispatch = vi.fn();
    const r = await handleCardAction({ ...WIRE, action: action(), dispatch });
    expect(r).toBe('ignored');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('ignores a click whose channel does not own the card (identity mismatch)', async () => {
    registerCardSession('m1', session());
    const dispatch = vi.fn();
    const r = await handleCardAction({ ...WIRE, action: action({ channelId: 'other-grp' }), dispatch });
    expect(r).toBe('ignored');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('ignores a click whose account does not own the card', async () => {
    registerCardSession('m1', session());
    const dispatch = vi.fn();
    const r = await handleCardAction({ ...WIRE, accountId: 'other-bot', action: action(), dispatch });
    expect(r).toBe('ignored');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('ignores an action id not present on the original card', async () => {
    registerCardSession('m1', session());
    const dispatch = vi.fn();
    const r = await handleCardAction({ ...WIRE, action: action({ actionId: 'delete_all' }), dispatch });
    expect(r).toBe('ignored');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects an input not on the card (recoverable: released, no dispatch)', async () => {
    registerCardSession('m1', session({ inputIds: ['note'] }));
    const dispatch = vi.fn();
    const r = await handleCardAction({ ...WIRE, action: action({ inputs: { evil: 'x' } }), dispatch });
    expect(r).toBe('rejected');
    expect(dispatch).not.toHaveBeenCalled();
    // recoverable → still claimable (released, not completed)
    expect(claimCardSession('m1', 999).status).toBe('claimed');
  });

  it('completes a valid click: dispatch runs once and status frames are written', async () => {
    registerCardSession('m1', session());
    const dispatch = vi.fn<() => Promise<CardActionDispatchResult>>().mockResolvedValue('completed');
    const r = await handleCardAction({ ...WIRE, action: action(), dispatch });
    expect(r).toBe('completed');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(mockEdit).toHaveBeenCalled(); // processing + completed frames
    // completed → frozen: a later click is a duplicate
    const dup = await handleCardAction({ ...WIRE, action: action({ eventId: 101 }), dispatch });
    expect(dup).toBe('duplicate');
  });

  it('a dispatch that returns "rejected" releases the claim (retryable)', async () => {
    registerCardSession('m1', session());
    const dispatch = vi.fn<() => Promise<CardActionDispatchResult>>().mockResolvedValue('rejected');
    const r = await handleCardAction({ ...WIRE, action: action(), dispatch });
    expect(r).toBe('rejected');
    expect(claimCardSession('m1', 999).status).toBe('claimed'); // released, not frozen
  });

  it('a throwing dispatch replays (rethrows) until it is dead-lettered after 3 attempts', async () => {
    registerCardSession('m1', session());
    const dispatch = vi.fn<() => Promise<CardActionDispatchResult>>().mockRejectedValue(new Error('boom'));
    const act = action({ eventId: 500 });
    // attempts 1 and 2: transient → rethrow (poller would replay the same event id)
    await expect(handleCardAction({ ...WIRE, action: act, dispatch })).rejects.toThrow('boom');
    await expect(handleCardAction({ ...WIRE, action: act, dispatch })).rejects.toThrow('boom');
    // attempt 3: dead-letter → complete, return normally (cursor advances), NO rethrow
    const r = await handleCardAction({ ...WIRE, action: act, dispatch });
    expect(r).toBe('rejected');
    expect(dispatch).toHaveBeenCalledTimes(3);
    // dead-lettered session is frozen — a further replay of the same event is a duplicate
    expect(claimCardSession('m1', 500).status).toBe('duplicate');
  });

  it('a reasoning-control action is a defensive no-op (never touches the card store)', async () => {
    const dispatch = vi.fn();
    const r = await handleCardAction({
      ...WIRE,
      action: action({ actionId: 'reasoning_stop', data: { action: 'reasoning_stop', owner: 'ai', action_type: 'reasoning.control' } }),
      dispatch,
    });
    expect(r).toBe('ignored');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
