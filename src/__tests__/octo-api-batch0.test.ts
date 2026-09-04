/**
 * Tests for the Batch-0 wire-layer endpoints added to octo/api.ts:
 * card send/edit/template, card profile (fail-closed) + capability derivation,
 * bot events, mention_pref, obo grant, presigned upload, target resolve, group
 * management, space members, voice CRUD, secret resolve, and doc replies.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  sendCardMessage,
  editCardMessage,
  sendTemplateCardMessage,
  getCardProfile,
  deriveCardCaps,
  deriveInteractiveCardCaps,
  fetchBotEvents,
  ackBotEvent,
  getMentionPref,
  getBotOboGrant,
  getUploadPresign,
  uploadFileToPresignedUrl,
  resolveTargetsByName,
  createGroup,
  updateGroup,
  addGroupMembers,
  removeGroupMembers,
  searchSpaceMembers,
  getVoiceContext,
  updateVoiceContext,
  deleteVoiceContext,
  resolveSecret,
  postDocComment,
  postHtmlDocReply,
  DocCommentRejectedError,
  isPermanentDocCommentFailure,
  jsonNumberLiteral,
  fetchBotGroups,
  getGroupInfo,
  MAX_EVENT_WAIT_SECONDS,
  eventsPollTimeoutMs,
} from '../octo/api.js';
import { ChannelType, MessageType, CARD_PROFILE, CARD_INTERACTIVE_PROFILE, CARD_VERSION } from '../octo/types.js';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyRes(status = 200): Response {
  return new Response('', { status });
}

function errRes(status: number, body = 'err'): Response {
  return new Response(body, { status, statusText: 'Error' });
}

/** Read the JSON body of the Nth fetch call. */
function bodyOf(callIndex = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const BASE = { apiUrl: 'https://test.example.com', botToken: 'bf_test' };
const CHAN = { channelId: 'g1', channelType: ChannelType.Group };

// ─── sendCardMessage ─────────────────────────────────────────────────────────

describe('sendCardMessage', () => {
  it('assembles a type-17 payload with octo/v1 for a display card', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ message_id: '1', client_msg_no: 'c', message_seq: 1 }));
    await sendCardMessage({ ...BASE, ...CHAN, card: { type: 'AdaptiveCard', body: [{ type: 'TextBlock', text: 'hi' }] } });
    const body = bodyOf();
    const payload = body.payload as Record<string, unknown>;
    expect(payload.type).toBe(MessageType.InteractiveCard);
    expect(payload.profile).toBe(CARD_PROFILE);
    expect(payload.card_version).toBe(CARD_VERSION);
    expect(body.channel_id).toBe('g1');
    expect(typeof body.client_msg_no).toBe('string');
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/bot/sendMessage');
  });

  it('upgrades to octo/v2 when the card carries Input.* or Action.Submit', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ message_id: '1', client_msg_no: 'c', message_seq: 1 }));
    await sendCardMessage({ ...BASE, ...CHAN, card: { type: 'AdaptiveCard', body: [{ type: 'Input.Text', id: 'x' }] } });
    expect((bodyOf().payload as Record<string, unknown>).profile).toBe(CARD_INTERACTIVE_PROFILE);
  });

  it('ignores a requested v1 profile when interaction forces v2', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ message_id: '1', client_msg_no: 'c', message_seq: 1 }));
    await sendCardMessage({
      ...BASE, ...CHAN, profile: CARD_PROFILE,
      card: { type: 'AdaptiveCard', actions: [{ type: 'Action.Submit' }] },
    });
    expect((bodyOf().payload as Record<string, unknown>).profile).toBe(CARD_INTERACTIVE_PROFILE);
  });

  it('attaches mention, reply and on_behalf_of when provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ message_id: '1', client_msg_no: 'c', message_seq: 1 }));
    await sendCardMessage({
      ...BASE, ...CHAN, card: { type: 'AdaptiveCard' },
      mentionUids: ['u1'], mentionAll: true, replyMsgId: 'm9', onBehalfOf: 'owner', plain: 'p',
    });
    const body = bodyOf();
    const payload = body.payload as Record<string, unknown>;
    expect(payload.mention).toEqual({ uids: ['u1'], all: 1 });
    expect(payload.reply).toEqual({ message_id: 'm9' });
    expect(payload.plain).toBe('p');
    expect(body.on_behalf_of).toBe('owner');
  });

  it('rejects an empty channelId', async () => {
    await expect(sendCardMessage({ ...BASE, channelId: '  ', channelType: ChannelType.Group, card: {} }))
      .rejects.toThrow(/channelId is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── editCardMessage ─────────────────────────────────────────────────────────

describe('editCardMessage', () => {
  it('serializes the full envelope into content_edit', async () => {
    fetchMock.mockResolvedValueOnce(emptyRes());
    await editCardMessage({ ...BASE, ...CHAN, messageId: 'm1', card: { type: 'AdaptiveCard' }, plain: 'x' });
    const body = bodyOf();
    expect(body.message_id).toBe('m1');
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/bot/message/edit');
    const envelope = JSON.parse(body.content_edit as string) as Record<string, unknown>;
    expect(envelope.type).toBe(MessageType.InteractiveCard);
    expect(envelope.profile).toBe(CARD_PROFILE);
    expect(envelope.plain).toBe('x');
  });

  it('embeds a valid card_seq (CAS) and transient flag', async () => {
    fetchMock.mockResolvedValueOnce(emptyRes());
    await editCardMessage({ ...BASE, ...CHAN, messageId: 'm1', card: {}, cardSeq: 5, transient: true });
    const envelope = JSON.parse(bodyOf().content_edit as string) as Record<string, unknown>;
    expect(envelope.card_seq).toBe(5);
    expect(envelope.transient).toBe(true);
  });

  it('omits transient when not set', async () => {
    fetchMock.mockResolvedValueOnce(emptyRes());
    await editCardMessage({ ...BASE, ...CHAN, messageId: 'm1', card: {}, cardSeq: 2 });
    const envelope = JSON.parse(bodyOf().content_edit as string) as Record<string, unknown>;
    expect('transient' in envelope).toBe(false);
  });

  it('rejects a non-positive or non-safe cardSeq', async () => {
    await expect(editCardMessage({ ...BASE, ...CHAN, messageId: 'm1', card: {}, cardSeq: 0 }))
      .rejects.toThrow(/cardSeq must be a positive safe integer/);
    await expect(editCardMessage({ ...BASE, ...CHAN, messageId: 'm1', card: {}, cardSeq: 1.5 }))
      .rejects.toThrow(/cardSeq must be a positive safe integer/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing messageId', async () => {
    await expect(editCardMessage({ ...BASE, ...CHAN, messageId: '', card: {} }))
      .rejects.toThrow(/messageId is required/);
  });
});

// ─── sendTemplateCardMessage ───────────────────────────────────────────────────

describe('sendTemplateCardMessage', () => {
  const ref = { id: 'tpl', version: '1' };

  it('posts template_ref/state/data and never on_behalf_of', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ message_id: '1', client_msg_no: 'c', message_seq: 1 }));
    await sendTemplateCardMessage({ ...BASE, ...CHAN, templateRef: ref, state: 's1', data: { state: 's1', title: 't' } });
    const body = bodyOf();
    const payload = body.payload as Record<string, unknown>;
    expect(payload.template_ref).toEqual(ref);
    expect(payload.state).toBe('s1');
    expect(payload.data).toEqual({ state: 's1', title: 't' });
    expect('on_behalf_of' in body).toBe(false);
  });

  it('rejects a templateRef with extra keys', async () => {
    await expect(sendTemplateCardMessage({
      ...BASE, ...CHAN,
      templateRef: { id: 'a', version: '1', extra: 'x' } as unknown as { id: string; version: string },
      state: 's', data: { state: 's' },
    })).rejects.toThrow(/templateRef must contain exactly id and version/);
  });

  it('rejects data whose state does not match', async () => {
    await expect(sendTemplateCardMessage({ ...BASE, ...CHAN, templateRef: ref, state: 's1', data: { state: 's2' } }))
      .rejects.toThrow(/data.state must match state/);
  });

  it('rejects data missing an own state key', async () => {
    await expect(sendTemplateCardMessage({ ...BASE, ...CHAN, templateRef: ref, state: 's1', data: {} }))
      .rejects.toThrow(/data must be a plain object with own state/);
  });
});

// ─── getCardProfile (FAIL-CLOSED) ──────────────────────────────────────────────

describe('getCardProfile fail-closed', () => {
  it('returns available:false when the endpoint is not deployed (404)', async () => {
    fetchMock.mockResolvedValueOnce(errRes(404));
    const m = await getCardProfile(BASE);
    expect(m).toEqual({ available: false, enabled: false });
  });

  it('returns available:true, enabled:false on an empty / non-object body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const m = await getCardProfile(BASE);
    expect(m).toEqual({ available: true, enabled: false });
  });

  it('returns available:true, enabled:false when JSON parsing fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const m = await getCardProfile(BASE);
    expect(m).toEqual({ available: true, enabled: false });
  });

  it('throws (does NOT fail open) on a non-404 non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(errRes(500, 'boom'));
    await expect(getCardProfile(BASE)).rejects.toThrow(/failed \(500\)/);
  });

  it('parses a full manifest and coerces enabled from 1', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({
      enabled: 1,
      profiles: ['octo/v1', 'octo/v2', 42],
      card_version: '1.5',
      elements: ['TextBlock', 7],
      inputs: ['Input.Text'],
      actions: ['Action.OpenUrl'],
      limits: { max_nodes: 200 },
    }));
    const m = await getCardProfile(BASE);
    expect(m.available).toBe(true);
    expect(m.enabled).toBe(true);
    // stringArray drops non-strings
    expect(m.profiles).toEqual(['octo/v1', 'octo/v2']);
    expect(m.elements).toEqual(['TextBlock']);
    expect(m.limits).toEqual({ max_nodes: 200 });
  });

  it('drops a malformed config while keeping available:true', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({
      enabled: true,
      config: { card_enabled: false, display_enabled: true, interaction_enabled: false, reasoning_enabled: false, reasoning_template_ref: null },
    }));
    const m = await getCardProfile(BASE);
    expect(m.available).toBe(true);
    expect(m.config).toBeUndefined();
  });

  it('keeps a well-formed config', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({
      enabled: true,
      config: { card_enabled: true, display_enabled: true, interaction_enabled: false, reasoning_enabled: false, reasoning_template_ref: null },
    }));
    const m = await getCardProfile(BASE);
    expect(m.config).toEqual({
      card_enabled: true, display_enabled: true, interaction_enabled: false,
      reasoning_enabled: false, reasoning_template_ref: null,
    });
  });
});

describe('deriveCardCaps / deriveInteractiveCardCaps', () => {
  it('preserves explicit empty capability arrays as authoritative', () => {
    const caps = deriveCardCaps({ available: true, enabled: true, elements: [], inputs: [], actions: [] });
    expect(caps.elements).toEqual(new Set());
    expect(caps.inputs).toEqual(new Set());
    expect(caps.actions).toEqual(new Set());
  });

  it('only accepts finite positive limits, normalized to integers', () => {
    const caps = deriveCardCaps({
      available: true, enabled: true,
      limits: { max_nodes: 200.9, max_depth: 0, max_payload_bytes: Number.POSITIVE_INFINITY, max_input_text_bytes: 4096.8, max_inputs_bytes: 16384 },
    });
    expect(caps).toEqual({ maxNodes: 200, maxInputTextBytes: 4096, maxInputsBytes: 16384 });
  });

  it('derives Submit from octo/v2, not from a stray actions entry', () => {
    const withV2 = deriveInteractiveCardCaps({ available: true, enabled: true, profiles: ['octo/v1', 'octo/v2'], actions: ['Action.OpenUrl'] });
    expect(withV2.actions).toEqual(new Set(['Action.OpenUrl', 'Action.Submit']));
    const withoutV2 = deriveInteractiveCardCaps({ available: true, enabled: true, profiles: ['octo/v1'], actions: ['Action.OpenUrl', 'Action.Submit'] });
    expect(withoutV2.actions).toEqual(new Set(['Action.OpenUrl']));
  });
});

// ─── fetchBotEvents / ackBotEvent ───────────────────────────────────────────────

describe('fetchBotEvents', () => {
  it('short-polls without a wait field and returns results', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ results: [{ event_id: 3, event_type: 'card_action' }] }));
    const events = await fetchBotEvents({ ...BASE, sinceEventId: 2, limit: 10 });
    const body = bodyOf();
    expect(body.event_id).toBe(2);
    expect(body.limit).toBe(10);
    expect('wait' in body).toBe(false);
    expect(events).toEqual([{ event_id: 3, event_type: 'card_action' }]);
  });

  it('long-polls with a clamped wait field', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ results: [] }));
    await fetchBotEvents({ ...BASE, waitSeconds: 999 });
    expect(bodyOf().wait).toBe(MAX_EVENT_WAIT_SECONDS);
  });

  it('returns [] when results is absent or non-array', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({}));
    expect(await fetchBotEvents(BASE)).toEqual([]);
  });

  it('clamps limit into [1,100]', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ results: [] }));
    await fetchBotEvents({ ...BASE, limit: 9999 });
    expect(bodyOf().limit).toBe(100);
  });
});

describe('eventsPollTimeoutMs', () => {
  it('uses the idle bound for no/zero wait and hold+margin otherwise', () => {
    expect(eventsPollTimeoutMs()).toBe(10_000);
    expect(eventsPollTimeoutMs(0)).toBe(10_000);
    expect(eventsPollTimeoutMs(20)).toBe(20 * 1000 + 10_000);
  });
});

describe('ackBotEvent', () => {
  it('POSTs to the per-event ack path', async () => {
    fetchMock.mockResolvedValueOnce(emptyRes());
    await ackBotEvent({ ...BASE, eventId: 42 });
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/bot/events/42/ack');
  });
});

// ─── getMentionPref ─────────────────────────────────────────────────────────────

describe('getMentionPref', () => {
  it('ANDs the two axes from a full response', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ no_mention: 1, group_allow_no_mention: true, effective: 1 }));
    expect(await getMentionPref({ ...BASE, groupNo: 'g' })).toEqual({ no_mention: true, group_allow_no_mention: true, effective: true });
  });

  it('degrades effective to no_mention on an old server (group axis absent)', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ no_mention: true }));
    expect(await getMentionPref({ ...BASE, groupNo: 'g' })).toEqual({ no_mention: true, group_allow_no_mention: true, effective: true });
  });

  it('falls back to effective:false on a non-2xx and never throws', async () => {
    fetchMock.mockResolvedValueOnce(errRes(404));
    expect(await getMentionPref({ ...BASE, groupNo: 'g' })).toEqual({ no_mention: false, group_allow_no_mention: true, effective: false });
  });

  it('falls back on a transport error and never throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    expect(await getMentionPref({ ...BASE, groupNo: 'g' })).toEqual({ no_mention: false, group_allow_no_mention: true, effective: false });
  });
});

// ─── getBotOboGrant ─────────────────────────────────────────────────────────────

describe('getBotOboGrant', () => {
  it('returns null on 404 (no grant)', async () => {
    fetchMock.mockResolvedValueOnce(errRes(404));
    expect(await getBotOboGrant(BASE)).toBeNull();
  });

  it('returns null when has_grant is explicitly false', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ has_grant: false, grantor_uid: 'u1' }));
    expect(await getBotOboGrant(BASE)).toBeNull();
  });

  it('accepts an implicit grant inferred from grantor_uid', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ grantor_uid: 'u1', persona_prompt: 'be nice', active: true }));
    expect(await getBotOboGrant(BASE)).toEqual({ has_grant: true, grantor_uid: 'u1', grantor_name: undefined, persona_prompt: 'be nice', active: true });
  });

  it('throws on a 5xx', async () => {
    fetchMock.mockResolvedValueOnce(errRes(500));
    await expect(getBotOboGrant(BASE)).rejects.toThrow(/failed \(500\)/);
  });
});

// ─── Presigned upload ───────────────────────────────────────────────────────────

describe('getUploadPresign', () => {
  it('requires a positive integer fileSize', async () => {
    await expect(getUploadPresign({ ...BASE, filename: 'f', fileSize: 0 })).rejects.toThrow(/positive integer fileSize/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('encodes query params and returns mapped fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ uploadUrl: 'https://u', downloadUrl: 'https://d', contentType: 'text/plain' }));
    const r = await getUploadPresign({ ...BASE, filename: 'a b.txt', fileSize: 12, contentType: 'text/plain' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('filename=a+b.txt');
    expect(url).toContain('fileSize=12');
    expect(url).toContain('contentType=text%2Fplain');
    expect(r).toEqual({ uploadUrl: 'https://u', downloadUrl: 'https://d', contentType: 'text/plain', contentDisposition: undefined });
  });

  it('throws on an incomplete response', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ uploadUrl: 'https://u' }));
    await expect(getUploadPresign({ ...BASE, filename: 'f', fileSize: 1 })).rejects.toThrow(/incomplete response.*downloadUrl/);
  });
});

describe('uploadFileToPresignedUrl', () => {
  it('PUTs the body with signed headers and returns the downloadUrl', async () => {
    fetchMock.mockResolvedValueOnce(emptyRes());
    const r = await uploadFileToPresignedUrl({
      uploadUrl: 'https://u', downloadUrl: 'https://d',
      fileBody: Buffer.from('hello'), fileSize: 5, contentType: 'text/plain', contentDisposition: 'inline',
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['Content-Length']).toBe('5');
    expect((init.headers as Record<string, string>)['Content-Disposition']).toBe('inline');
    expect(r).toEqual({ url: 'https://d' });
  });

  it('throws on a failed PUT', async () => {
    fetchMock.mockResolvedValueOnce(errRes(403, 'SignatureDoesNotMatch'));
    await expect(uploadFileToPresignedUrl({
      uploadUrl: 'https://u', downloadUrl: 'https://d', fileBody: Buffer.from('x'), fileSize: 1, contentType: 'text/plain',
    })).rejects.toThrow(/Presigned PUT upload failed \(403\)/);
  });
});

// ─── resolveTargetsByName ───────────────────────────────────────────────────────

describe('resolveTargetsByName', () => {
  it('maps snake_case candidates into the camelCase shape', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({
      candidates: [
        { kind: 'group', channel_id: 'g1', channel_type: 2, name: 'G', group_no: 'g1' },
        { kind: 'thread', channel_id: 'g1____t1', channel_type: 5, name: 'T', group_no: 'g1', short_id: 't1', parent_name: 'G' },
      ],
      total: 2,
    }));
    const r = await resolveTargetsByName({ ...BASE, name: 'X' });
    expect(r.total).toBe(2);
    expect(r.candidates[1]).toEqual({ kind: 'thread', channelId: 'g1____t1', channelType: 5, name: 'T', groupNo: 'g1', shortId: 't1', parentName: 'G' });
  });

  it('fails closed to truncated when total is missing and the limit is hit', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({
      candidates: [{ kind: 'group', channel_id: 'g1', channel_type: 2, name: 'G', group_no: 'g1' }],
    }));
    const r = await resolveTargetsByName({ ...BASE, name: 'X', limit: 1 });
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(1);
  });

  it('throws on a non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(errRes(500));
    await expect(resolveTargetsByName({ ...BASE, name: 'X' })).rejects.toThrow(/failed \(500\)/);
  });
});

// ─── Group management ───────────────────────────────────────────────────────────

describe('group management', () => {
  it('createGroup posts members/creator and space_id when set', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ group_no: 'g9', name: 'New' }));
    const r = await createGroup({ ...BASE, members: ['u1', 'u2'], creator: 'u1', name: 'New', spaceId: 's1' });
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/bot/createGroup');
    expect(bodyOf()).toEqual({ name: 'New', members: ['u1', 'u2'], creator: 'u1', space_id: 's1' });
    expect(r).toEqual({ group_no: 'g9', name: 'New' });
  });

  it('updateGroup only sends provided fields', async () => {
    fetchMock.mockResolvedValueOnce(emptyRes());
    await updateGroup({ ...BASE, groupNo: 'g1', notice: 'hello' });
    expect(bodyOf()).toEqual({ notice: 'hello' });
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/bot/groups/g1/info');
  });

  it('addGroupMembers / removeGroupMembers return their counts', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, added: 2 }));
    expect(await addGroupMembers({ ...BASE, groupNo: 'g1', members: ['a', 'b'] })).toEqual({ ok: true, added: 2 });
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, removed: 1 }));
    expect(await removeGroupMembers({ ...BASE, groupNo: 'g1', members: ['a'] })).toEqual({ ok: true, removed: 1 });
  });

  it('createGroup throws on a non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(errRes(403, 'no'));
    await expect(createGroup({ ...BASE, members: [], creator: 'u1' })).rejects.toThrow(/failed \(403\)/);
  });
});

// ─── searchSpaceMembers ─────────────────────────────────────────────────────────

describe('searchSpaceMembers', () => {
  it('sends query params and returns the array', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([{ uid: 'u1', name: 'A', robot: 0 }]));
    const r = await searchSpaceMembers({ ...BASE, keyword: 'a', spaceId: 's1', limit: 5 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('keyword=a');
    expect(url).toContain('space_id=s1');
    expect(url).toContain('limit=5');
    expect(r).toEqual([{ uid: 'u1', name: 'A', robot: 0 }]);
  });
});

// ─── Voice context CRUD ─────────────────────────────────────────────────────────

describe('voice context', () => {
  it('getVoiceContext normalizes missing fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ context: 'hi' }));
    expect(await getVoiceContext(BASE)).toEqual({ has_context: false, context: 'hi', updated_at: '' });
  });

  it('updateVoiceContext PUTs the context field', async () => {
    fetchMock.mockResolvedValueOnce(emptyRes());
    await updateVoiceContext({ ...BASE, content: 'fix this' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(bodyOf()).toEqual({ context: 'fix this' });
  });

  it('deleteVoiceContext issues a DELETE', async () => {
    fetchMock.mockResolvedValueOnce(emptyRes());
    await deleteVoiceContext(BASE);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('DELETE');
  });

  it('getVoiceContext throws on a non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(errRes(500));
    await expect(getVoiceContext(BASE)).rejects.toThrow(/GET \/v1\/bot\/voice\/context failed \(500\)/);
  });
});

// ─── resolveSecret ──────────────────────────────────────────────────────────────

describe('resolveSecret', () => {
  it('sends the alias as the wire field `query`', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ value: 'sk-xyz', secret_id: 'id1' }));
    await resolveSecret({ ...BASE, alias: 'openai' });
    expect(bodyOf()).toEqual({ query: 'openai' });
  });

  it('returns resolved with the plaintext value on a 200 without status', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ value: 'sk-xyz', secret_id: 'id1' }));
    expect(await resolveSecret({ ...BASE, alias: 'openai' })).toEqual({ status: 'resolved', value: 'sk-xyz', secret_id: 'id1', display_name: undefined });
  });

  it('maps 404 → not_found', async () => {
    fetchMock.mockResolvedValueOnce(errRes(404));
    expect(await resolveSecret({ ...BASE, alias: 'x' })).toEqual({ status: 'not_found' });
  });

  it('maps 422 → ambiguous with label-only candidates', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({
      error: { details: { candidates: [{ display_name: 'A', secret_id: 'i1', value: 'LEAK', masked: 'x' }, { secret_id: 'i2' }] } },
    }, 422));
    const r = await resolveSecret({ ...BASE, alias: 'x' });
    expect(r).toEqual({ status: 'ambiguous', candidates: [{ display_name: 'A', secret_id: 'i1' }] });
    // dropped: the value-only candidate with no display_name, and never the secret value
    expect(JSON.stringify(r)).not.toContain('LEAK');
  });

  it('maps 429 → rate_limited without reading the body', async () => {
    fetchMock.mockResolvedValueOnce(errRes(429));
    expect(await resolveSecret({ ...BASE, alias: 'x' })).toEqual({ status: 'rate_limited' });
  });

  it('throws with the status ONLY (no body) on a 5xx', async () => {
    fetchMock.mockResolvedValueOnce(errRes(500, 'sk-should-not-leak'));
    await expect(resolveSecret({ ...BASE, alias: 'x' })).rejects.toThrow(/^resolveSecret failed \(500\)$/);
  });

  it('rejects a resolved response with an empty value', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ value: '' }));
    await expect(resolveSecret({ ...BASE, alias: 'x' })).rejects.toThrow(/no value/);
  });
});

// ─── Doc comment / HTML doc reply ────────────────────────────────────────────────

describe('jsonNumberLiteral', () => {
  it('rejects non-positive-decimal strings', () => {
    expect(jsonNumberLiteral('0')).toBeUndefined();
    expect(jsonNumberLiteral('-5')).toBeUndefined();
    expect(jsonNumberLiteral('1.2')).toBeUndefined();
    expect(jsonNumberLiteral('abc')).toBeUndefined();
  });

  it('emits a snowflake id verbatim as a JSON number', () => {
    const literal = jsonNumberLiteral('7385000000000000123');
    expect(JSON.stringify({ parentId: literal })).toBe('{"parentId":7385000000000000123}');
  });
});

describe('postDocComment', () => {
  it('writes parentId losslessly as a JSON number', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 1 }));
    await postDocComment({ ...BASE, docId: 'd1', parentId: '7385000000000000123', body: 'hi' });
    const rawBody = (fetchMock.mock.calls[0][1] as RequestInit).body as string;
    expect(rawBody).toContain('"parentId":7385000000000000123');
  });

  it('omits parentId (posts at root) when the id cannot be represented losslessly', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 1 }));
    await postDocComment({ ...BASE, docId: 'd1', parentId: 'not-a-number', body: 'hi' });
    expect('parentId' in bodyOf()).toBe(false);
  });

  it('throws DocCommentRejectedError on a status!=1 envelope', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 0, msg: 'doc gone' }));
    await expect(postDocComment({ ...BASE, docId: 'd1', body: 'hi' })).rejects.toBeInstanceOf(DocCommentRejectedError);
  });

  it('resolves when the response has no status field (HTTP semantics)', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([{ id: 1 }]));
    await expect(postDocComment({ ...BASE, docId: 'd1', body: 'hi' })).resolves.toBeUndefined();
  });
});

describe('isPermanentDocCommentFailure', () => {
  it('treats a DocCommentRejectedError and deterministic 4xx as permanent', () => {
    expect(isPermanentDocCommentFailure(new DocCommentRejectedError('x'))).toBe(true);
    expect(isPermanentDocCommentFailure(new Error('Octo API /p failed (400): bad'))).toBe(true);
  });

  it('treats come-back-later statuses and 5xx as retriable', () => {
    expect(isPermanentDocCommentFailure(new Error('Octo API /p failed (429): slow'))).toBe(false);
    expect(isPermanentDocCommentFailure(new Error('Octo API /p failed (503): down'))).toBe(false);
    expect(isPermanentDocCommentFailure(new Error('network timeout'))).toBe(false);
  });
});

describe('postHtmlDocReply', () => {
  it('maps intent to the status marker and posts to the docs-html path', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ data: {} }));
    await postHtmlDocReply({ ...BASE, slug: 's', parentId: 'p1', body: 'done', intent: 'final' });
    expect(fetchMock.mock.calls[0][0]).toContain('/docs-html/v1/agent/replies');
    expect(bodyOf()).toEqual({ slug: 's', parent_id: 'p1', text: 'done', status: 'applied' });
  });

  it('maps progress → partial and notice → question', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ data: {} }));
    await postHtmlDocReply({ ...BASE, slug: 's', parentId: 'p1', body: 'x', intent: 'progress' });
    expect(bodyOf().status).toBe('partial');
    fetchMock.mockResolvedValueOnce(jsonRes({ data: {} }));
    await postHtmlDocReply({ ...BASE, slug: 's', parentId: 'p1', body: 'x', intent: 'notice' });
    expect(bodyOf(1).status).toBe('question');
  });
});

// ─── fetchBotGroups / getGroupInfo ───────────────────────────────────────────────

describe('fetchBotGroups', () => {
  it('returns the array on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([{ group_no: 'g1', name: 'G' }]));
    expect(await fetchBotGroups(BASE)).toEqual([{ group_no: 'g1', name: 'G' }]);
  });

  it('returns [] (best-effort) on a non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(errRes(500));
    expect(await fetchBotGroups(BASE)).toEqual([]);
  });

  it('returns [] on a transport error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect(await fetchBotGroups(BASE)).toEqual([]);
  });
});

describe('getGroupInfo', () => {
  it('returns the group object on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ group_no: 'g1', name: 'G', extra: 1 }));
    expect(await getGroupInfo({ ...BASE, groupNo: 'g1' })).toEqual({ group_no: 'g1', name: 'G', extra: 1 });
  });

  it('throws on a non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(errRes(404));
    await expect(getGroupInfo({ ...BASE, groupNo: 'g1' })).rejects.toThrow(/failed \(404\)/);
  });
});
