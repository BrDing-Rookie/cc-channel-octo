/**
 * E2: OBO v2 relay-envelope decision (pure, unit-testable).
 *
 * A persona clone (a bot configured with `onBehalfOf: <grantor_uid>`) can receive
 * an OBO v2 RELAY message from its grantor: the grantor forwards a message from
 * some ORIGIN channel to the bot, carrying `obo_*` fields that say "reply to that
 * origin channel, as my persona". The bot then answers into the origin channel
 * with `on_behalf_of = grantor`.
 *
 * 🔴 SECURITY — anti-impersonation hard red line: the `obo_*` fields are honored
 * ONLY when the message is sent by the CONFIGURED grantor (`config.onBehalfOf`)
 * AND `msg.from_uid === config.onBehalfOf`. Any other sender that stuffs `obo_*`
 * into its payload is ignored (treated as a normal message), because otherwise
 * anyone could make the bot reply in another channel as somebody else's persona.
 * The reply identity (`effectiveOnBehalfOf`) is ALWAYS the configured grantor,
 * never the payload's `obo_respond_as` (which is kept for diagnostics only).
 *
 * Relevance filter: an OBO v2 fan-out that targets AI bots only (`mention.ais=1`
 * with no grantor mention and no @所有人/@all) is NOT relevant to the persona —
 * the caller drops it BEFORE recording any session state (state-pollution guard).
 * Broadcast mentions (`humans`/`all`), an explicit grantor-uid mention, or a
 * payload with no mention info at all are relevant.
 *
 * This module is pure so the security-critical decision can be tested directly.
 * The reply-target override and the early-return are applied by the caller
 * (index.ts handleMessage); the session/context stays on the inbound channel.
 */

import type { BotMessage } from './octo/types.js';
import { ChannelType } from './octo/types.js';

export interface OboRelayDecision {
  /** True iff this is a trusted OBO v2 relay (envelope present + from the configured grantor). */
  isOBOv2: boolean;
  /**
   * Relevance verdict. Always true for a non-OBO message (normal processing).
   * For an OBO v2 message, false means "irrelevant fan-out — drop before any
   * state is recorded".
   */
  relevant: boolean;
  /** Origin channel to reply into (only set when isOBOv2). */
  replyChannelId?: string;
  /** Origin channel type to reply into (only set when isOBOv2). */
  replyChannelType?: ChannelType;
  /** Grantor to send the reply on behalf of — always the CONFIGURED grantor (only set when isOBOv2). */
  effectiveOnBehalfOf?: string;
  /** Payload's respond_as, for diagnostics only (may differ from effectiveOnBehalfOf). */
  payloadRespondAs?: string;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function truthyFlag(v: unknown): boolean {
  return v === true || v === 1;
}

/**
 * Decide whether an inbound message is a trusted OBO v2 relay and, if so, where
 * the reply should go and under whose identity. Never throws; a non-OBO or
 * untrusted message returns `{ isOBOv2: false, relevant: true }` so the caller
 * processes it as an ordinary message.
 */
export function decideOboRelay(
  msg: BotMessage,
  configuredGrantor: string | undefined,
): OboRelayDecision {
  const payload = msg.payload ?? {};
  const originChannel = asNonEmptyString(payload.obo_origin_channel_id);
  const originChannelType = payload.obo_origin_channel_type;
  const respondAs = asNonEmptyString(payload.obo_respond_as) ?? asNonEmptyString(payload.obo_grantor_uid);

  // Anti-impersonation: only trust the envelope when it is complete AND the
  // sender is exactly the configured grantor. Everything else → not OBO.
  const isOBOv2 = Boolean(
    originChannel &&
    respondAs &&
    configuredGrantor &&
    msg.from_uid === configuredGrantor,
  );

  if (!isOBOv2) {
    return { isOBOv2: false, relevant: true };
  }

  // Relevance filter (state-pollution guard runs in the caller on !relevant).
  const mention = payload.mention;
  const ais = truthyFlag(mention?.ais);
  const humans = truthyFlag(mention?.humans);
  const all = truthyFlag(mention?.all);
  const uids: string[] = Array.isArray(mention?.uids) ? (mention?.uids as string[]) : [];
  const grantorInUids = !!configuredGrantor && uids.includes(configuredGrantor);
  const broadcastRelevant = humans || all;
  const noMentionFallback = !ais && !humans && !all && uids.length === 0;
  const relevant = broadcastRelevant || grantorInUids || noMentionFallback;

  const resolvedType: ChannelType =
    typeof originChannelType === 'number' ? (originChannelType as ChannelType) : ChannelType.Group;
  const originFromUid = asNonEmptyString(payload.obo_origin_from_uid);
  const replyChannelId =
    resolvedType === ChannelType.DM ? (originFromUid ?? originChannel!) : originChannel!;

  return {
    isOBOv2: true,
    relevant,
    replyChannelId,
    replyChannelType: resolvedType,
    // 🔴 Always the CONFIGURED grantor, never the payload's respondAs.
    effectiveOnBehalfOf: configuredGrantor,
    payloadRespondAs: respondAs,
  };
}
