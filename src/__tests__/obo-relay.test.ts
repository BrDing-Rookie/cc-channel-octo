/**
 * E2 obo-relay tests: the anti-impersonation + relevance decision. These cover
 * the security-critical logic directly (the caller in index.ts only applies the
 * early-return + reply-target override this returns).
 */
import { describe, it, expect } from 'vitest';
import { decideOboRelay } from '../obo-relay.js';
import type { BotMessage } from '../octo/types.js';
import { ChannelType, MessageType } from '../octo/types.js';

const GRANTOR = 'grantor-uid';

function msg(payload: Record<string, unknown>, fromUid = GRANTOR): BotMessage {
  return {
    message_id: '1',
    message_seq: 1,
    from_uid: fromUid,
    channel_id: 'relay-dm',
    channel_type: ChannelType.DM,
    timestamp: 1,
    payload: { type: MessageType.Text, content: 'x', ...payload },
  };
}

describe('decideOboRelay — non-OBO passthrough', () => {
  it('a plain message → not OBO, relevant (normal processing)', () => {
    const d = decideOboRelay(msg({}), GRANTOR);
    expect(d.isOBOv2).toBe(false);
    expect(d.relevant).toBe(true);
    expect(d.effectiveOnBehalfOf).toBeUndefined();
  });

  it('envelope present but no configured grantor → not OBO', () => {
    const d = decideOboRelay(msg({ obo_origin_channel_id: 'g9', obo_respond_as: GRANTOR }), undefined);
    expect(d.isOBOv2).toBe(false);
  });
});

describe('decideOboRelay — anti-impersonation (hard red line)', () => {
  it('rejects the envelope when the sender is NOT the configured grantor', () => {
    const d = decideOboRelay(
      msg({ obo_origin_channel_id: 'g9', obo_origin_channel_type: ChannelType.Group, obo_respond_as: GRANTOR }, 'attacker-uid'),
      GRANTOR,
    );
    expect(d.isOBOv2).toBe(false);
    expect(d.relevant).toBe(true); // falls through to normal processing, not an OBO reply
  });

  it('accepts only when from_uid === configured grantor', () => {
    const d = decideOboRelay(
      msg({ obo_origin_channel_id: 'g9', obo_origin_channel_type: ChannelType.Group, obo_respond_as: GRANTOR }),
      GRANTOR,
    );
    expect(d.isOBOv2).toBe(true);
  });

  it('effectiveOnBehalfOf is ALWAYS the configured grantor, never the payload respond_as', () => {
    const d = decideOboRelay(
      msg({ obo_origin_channel_id: 'g9', obo_origin_channel_type: ChannelType.Group, obo_respond_as: 'someone-else' }),
      GRANTOR,
    );
    expect(d.isOBOv2).toBe(true);
    expect(d.effectiveOnBehalfOf).toBe(GRANTOR);
    expect(d.payloadRespondAs).toBe('someone-else');
  });
});

describe('decideOboRelay — relevance filter', () => {
  const base = { obo_origin_channel_id: 'g9', obo_origin_channel_type: ChannelType.Group, obo_respond_as: GRANTOR };

  it('@AI-only fan-out is NOT relevant (persona should not answer)', () => {
    const d = decideOboRelay(msg({ ...base, mention: { ais: 1 } }), GRANTOR);
    expect(d.isOBOv2).toBe(true);
    expect(d.relevant).toBe(false);
  });

  it('@所有人 (humans) is relevant', () => {
    expect(decideOboRelay(msg({ ...base, mention: { humans: 1 } }), GRANTOR).relevant).toBe(true);
  });

  it('legacy all=1 is relevant', () => {
    expect(decideOboRelay(msg({ ...base, mention: { all: 1 } }), GRANTOR).relevant).toBe(true);
  });

  it('an explicit grantor-uid mention is relevant even alongside ais', () => {
    const d = decideOboRelay(msg({ ...base, mention: { ais: 1, uids: [GRANTOR] } }), GRANTOR);
    expect(d.relevant).toBe(true);
  });

  it('no mention info at all → relevant (plain chatter fallback)', () => {
    expect(decideOboRelay(msg({ ...base }), GRANTOR).relevant).toBe(true);
  });

  it('ais + non-grantor uids only → not relevant', () => {
    const d = decideOboRelay(msg({ ...base, mention: { ais: 1, uids: ['someone'] } }), GRANTOR);
    expect(d.relevant).toBe(false);
  });
});

describe('decideOboRelay — reply-target routing', () => {
  it('group origin → reply to the origin channel', () => {
    const d = decideOboRelay(
      msg({ obo_origin_channel_id: 'origin-group', obo_origin_channel_type: ChannelType.Group, obo_respond_as: GRANTOR }),
      GRANTOR,
    );
    expect(d.replyChannelId).toBe('origin-group');
    expect(d.replyChannelType).toBe(ChannelType.Group);
  });

  it('DM origin → reply to the original sender uid (obo_origin_from_uid)', () => {
    const d = decideOboRelay(
      msg({ obo_origin_channel_id: 'origin-dm', obo_origin_channel_type: ChannelType.DM, obo_origin_from_uid: 'bob', obo_respond_as: GRANTOR }),
      GRANTOR,
    );
    expect(d.replyChannelType).toBe(ChannelType.DM);
    expect(d.replyChannelId).toBe('bob');
  });

  it('DM origin without origin_from_uid → falls back to the origin channel id', () => {
    const d = decideOboRelay(
      msg({ obo_origin_channel_id: 'origin-dm', obo_origin_channel_type: ChannelType.DM, obo_respond_as: GRANTOR }),
      GRANTOR,
    );
    expect(d.replyChannelId).toBe('origin-dm');
  });

  it('missing/unknown origin channel type defaults to Group', () => {
    const d = decideOboRelay(
      msg({ obo_origin_channel_id: 'origin-x', obo_respond_as: GRANTOR }),
      GRANTOR,
    );
    expect(d.replyChannelType).toBe(ChannelType.Group);
    expect(d.replyChannelId).toBe('origin-x');
  });
});
