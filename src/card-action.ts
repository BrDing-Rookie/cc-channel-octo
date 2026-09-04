import { ChannelType, MessageType, type BotEvent, type BotMessage } from './octo/types.js';
import { isSensitive } from './card-render.js';

export interface CardAction {
  eventId: number;
  messageId: string;
  channelId: string;
  channelType: ChannelType;
  actionId: string;
  inputs: Record<string, string>;
  operatorUid: string;
  data?: Record<string, unknown>;
  spaceId?: string;
  clientToken?: string;
  actedAt?: number;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function channelTypeValue(value: unknown): ChannelType | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (
    numeric !== ChannelType.DM &&
    numeric !== ChannelType.Group &&
    numeric !== ChannelType.CommunityTopic
  ) {
    return null;
  }
  return numeric;
}

/** Parse the server-authoritative card_action envelope without trusting form input values. */
export function parseCardAction(event: BotEvent): CardAction | null {
  if (
    !Number.isSafeInteger(event.event_id) ||
    event.event_id < 0 ||
    event.event_type !== 'card_action' ||
    !event.event_data ||
    typeof event.event_data !== 'object'
  ) {
    return null;
  }

  const data = event.event_data;
  const messageId = stringValue(data.message_id);
  const channelId = stringValue(data.channel_id);
  const channelType = channelTypeValue(data.channel_type);
  const actionId = stringValue(data.action_id);
  const operatorUid = stringValue(data.operator_uid);
  if (!messageId || !channelId || channelType === null || !actionId || !operatorUid) return null;

  const inputs: Record<string, string> = {};
  if (data.inputs && typeof data.inputs === 'object' && !Array.isArray(data.inputs)) {
    for (const [key, value] of Object.entries(data.inputs as Record<string, unknown>)) {
      // The server contract serializes every submitted value as a string, but normalize a raw
      // JSON number/boolean (e.g. an Input.Number / Input.Toggle value) to its string form rather
      // than dropping it: a dropped field still passes validation (missing keys are allowed) and
      // would reach the agent as silently incomplete input. `false` / `0` must normalize too, so
      // this tests the type, not truthiness. Objects / arrays / null / non-finite numbers stay
      // dropped as malformed or unsupported envelope shapes.
      if (typeof value === 'string') inputs[key] = value;
      else if (typeof value === 'boolean') inputs[key] = String(value);
      else if (typeof value === 'number' && Number.isFinite(value)) inputs[key] = String(value);
    }
  }

  const action: CardAction = {
    eventId: event.event_id,
    messageId,
    channelId,
    channelType,
    actionId,
    inputs,
    operatorUid,
  };
  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
    action.data = data.data as Record<string, unknown>;
  }
  const spaceId = stringValue(data.space_id);
  if (spaceId) action.spaceId = spaceId;
  const clientToken = stringValue(data.client_token);
  if (clientToken) action.clientToken = clientToken;
  if (typeof data.acted_at === 'number' && Number.isFinite(data.acted_at)) {
    action.actedAt = data.acted_at;
  }
  return action;
}

/** Keep user-controlled input inside a JSON value instead of interpolating it as control text. */
export function formatCardActionText(action: CardAction): string {
  const lines = [
    '[Octo card action]',
    `action_id=${action.actionId}`,
    `inputs=${JSON.stringify(action.inputs)}`,
  ];
  if (action.data) lines.push(`data=${JSON.stringify(action.data)}`);
  return lines.join('\n');
}

/** Translate a verified card action into the same message shape used by the normal inbound path. */
export function synthesizeCardActionMessage(action: CardAction, botUid: string): BotMessage {
  // card_action uses the peer uid as channel_id for DMs. Reconstruct an internal
  // space-aware channel id so the normal inbound path derives the same Space session/queue.
  const channelId = action.channelType === ChannelType.DM && action.spaceId
    ? `s${action.spaceId}_${action.operatorUid}`
    : action.channelId;
  return {
    message_id: `card_action:${action.eventId}`,
    message_seq: 0,
    from_uid: action.operatorUid,
    channel_id: channelId,
    channel_type: action.channelType,
    timestamp: action.actedAt ?? Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content: formatCardActionText(action),
      // Mention the bot so the re-run passes the group @mention gate regardless of
      // the group's mention preference — the click is an explicit request to the bot.
      mention: { uids: [botUid] },
    },
  };
}

export function validateCardActionInputs(
  action: CardAction,
  limits?: {
    inputIds?: readonly string[];
    maxInputTextBytes?: number;
    maxInputsBytes?: number;
  },
): { ok: true } | { ok: false; error: string } {
  const maxInputTextBytes = limits?.maxInputTextBytes ?? 4_096;
  const maxInputsBytes = limits?.maxInputsBytes ?? 16_384;
  const inputIds = new Set(limits?.inputIds ?? []);
  const encoder = new TextEncoder();
  for (const [key, value] of Object.entries(action.inputs)) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) return { ok: false, error: '提交字段非法' };
    if (!inputIds.has(key)) return { ok: false, error: '提交字段与原卡不匹配' };
    if (isSensitive(key, true) || isSensitive(value, true)) {
      return { ok: false, error: '提交内容包含敏感信息' };
    }
    if (encoder.encode(value).byteLength > maxInputTextBytes) {
      return { ok: false, error: '提交内容过大' };
    }
  }
  if (encoder.encode(JSON.stringify(action.inputs)).byteLength > maxInputsBytes) {
    return { ok: false, error: '提交内容过大' };
  }
  return { ok: true };
}
