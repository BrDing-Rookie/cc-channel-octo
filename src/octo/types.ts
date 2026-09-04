// Forked from openclaw-channel-octo v1.0.13 (2026-06-04)
// Source: https://github.com/Mininglamp-OSS/openclaw-channel-octo

/** Octo Bot API types. */

export interface BotRegisterResp {
  robot_id: string;
  im_token: string;
  ws_url: string;
  api_url: string;
  owner_uid: string;
  owner_channel_id: string;
}

export interface BotMessage {
  message_id: string;
  message_seq: number;
  from_uid: string;
  from_name?: string;
  channel_id?: string;
  channel_type?: ChannelType;
  timestamp: number;
  payload: MessagePayload;
  /** True when this message is part of a streaming sequence (WuKongIM settingByte bit 1). */
  streamOn?: boolean;
}

/**
 * 单个 mention 的精确位置描述。
 * offset/length 的单位为 UTF-16 code units（与 JS string.length 一致）。
 */
export interface MentionEntity {
  /** 被 @ 用户的唯一标识符 */
  uid: string;
  /** @name 在 content 中的起始位置（包括 @ 符号） */
  offset: number;
  /** @name 的完整长度（包括 @ 符号） */
  length: number;
}

export interface MentionPayload {
  uids?: string[];
  entities?: MentionEntity[];
  /**
   * Legacy "@all" flag. Server outbound double-writes this for legacy clients
   * even after the three-state split landed (server-side semantic: all=humans).
   * Adapter treats `all=1` as a humans-only signal (NOT ais) to match the
   * server's authoritative decision.
   */
  all?: boolean | number;
  /**
   * Three-state mention (server-authoritative, PR-A landed on octo-server #94).
   * `humans=1` → "@所有人", `ais=1` → "@所有AI". Both can co-exist.
   * Adapter only reads these; it never decides semantics — server is the
   * source of truth and rewrites legacy `all=1` into the canonical form
   * before adapter sees it.
   */
  humans?: boolean | number;
  ais?: boolean | number;
}

export interface ReplyPayload {
  payload?: MessagePayload;
  from_uid?: string;
  from_name?: string;
}

export interface MessagePayload {
  type: MessageType;
  content?: string;
  url?: string;
  name?: string;
  mention?: MentionPayload;
  reply?: ReplyPayload;
  event?: {
    type: string;
    version?: number;
    updated_by?: string;
    group_no?: string;
    short_id?: string;
  };
  [key: string]: unknown;
}

export interface SendMessageResult {
  message_id: string;  // string due to int64 protection in postJson
  client_msg_no: string;
  message_seq: number;
}

/** Channel types */
export enum ChannelType {
  DM = 1,
  Group = 2,
  CommunityTopic = 5,
}

/**
 * A thread (CommunityTopic) under a parent group, as returned by the Octo bot
 * thread lifecycle endpoints. A thread's channel_id is the composite
 * `<groupNo>____<shortId>` (see octo/channel-id.ts).
 */
export interface Thread {
  /** Thread short id; the right-hand side of the composite channel_id. */
  short_id: string;
  name: string;
  /** uid of the member who created the thread. */
  creator_uid: string;
  /** Lifecycle status flag (server-defined). Absent on the create response. */
  status?: number;
  /** Current member count. Present on getThread. */
  member_count?: number;
}

/** A single member of a thread, as returned by listThreadMembers. */
export interface ThreadMember {
  uid: string;
  /** Member role within the thread (server-defined). */
  role: number;
}

/** Message content types */
export enum MessageType {
  Text = 1,
  Image = 2,
  GIF = 3,
  Voice = 4,
  Video = 5,
  Location = 6,
  Card = 7,
  File = 8,
  MultipleForward = 11,
  /** Rich text (text + inline images), introduced in upstream v1.0.x */
  RichText = 14,
  /**
   * Interactive card (Adaptive Cards 1.5). InteractiveCard(17) ≠ common Card(7);
   * new card logic must target 17, never 7 (octo-server PR #525 P1).
   */
  InteractiveCard = 17,
}

/**
 * InteractiveCard(=17) protocol profile / version (octo-server Decision 10
 * negotiated values). A display card defaults to `octo/v1`; a card carrying any
 * `Input.*` / `Action.Submit` is upgraded to `octo/v2`. `card_version` is fixed
 * at `1.5` — a non-`octo/v1`+`1.5` combination is rejected server-side with 400.
 */
export const CARD_PROFILE = "octo/v1";
export const CARD_INTERACTIVE_PROFILE = "octo/v2";
export const CARD_VERSION = "1.5";
export type CardProfile = typeof CARD_PROFILE | typeof CARD_INTERACTIVE_PROFILE;

/**
 * A single candidate returned by the name → target resolver
 * (GET /v1/bot/resolve/targets, octo-server PR #337).
 *
 * Group candidates carry only the group identity; thread candidates additionally
 * carry `shortId` + `parentName`. There is no `parentGroupNo` — `groupNo` already
 * holds the parent group for a thread.
 */
export interface TargetCandidate {
  kind: "group" | "thread";
  /** group: group_no ; thread: group_no____short_id (four underscores). */
  channelId: string;
  /** 2 = group, 5 = thread (CommunityTopic). */
  channelType: ChannelType;
  name: string;
  groupNo: string;
  /** Thread only. */
  shortId?: string;
  /** Thread only. */
  parentName?: string;
}

/**
 * A typed bot event returned by GET /v1/bot/events (octo-server card-action
 * callback queue). The gateway's poll loop reads `event_id` as the cursor and
 * dispatches on `event_type` / `event_data`; the wire shape is intentionally
 * permissive because the queue carries several event families.
 */
export interface BotEvent {
  event_id: number;
  event_type?: string;
  event_data?: Record<string, unknown>;
  message?: Record<string, unknown>;
}

/**
 * The authoritative set of renderer capabilities derived from the server card
 * profile manifest (see api.ts `getCardProfile` / `deriveCardCaps`). All fields
 * are optional: an absent field means "the server did not advertise this axis",
 * which consumers treat as a conservative baseline (fail-closed).
 */
export interface CardCaps {
  /** Server-advertised element whitelist (pkg/cardmsg authoritative). */
  elements?: ReadonlySet<string>;
  /** Server-advertised input whitelist (Input.Text/Toggle/ChoiceSet/Number/Date/Time). */
  inputs?: ReadonlySet<string>;
  /** Server-advertised local/navigation actions; interactive builders derive Submit from the octo/v2 profile. */
  actions?: ReadonlySet<string>;
  /** Max recursive node count (limits.max_nodes). */
  maxNodes?: number;
  /** Max rendered-JSON object depth (limits.max_depth). */
  maxDepth?: number;
  /** Max UTF-8 byte size of the full type-17 payload (limits.max_payload_bytes). */
  maxPayloadBytes?: number;
  /** Max UTF-8 byte size of a single Input.Text value (limits.max_input_text_bytes). */
  maxInputTextBytes?: number;
  /** Max UTF-8 byte size of the serialized inputs map (limits.max_inputs_bytes). */
  maxInputsBytes?: number;
}

/**
 * RichText(=14) block type constants.
 *
 * Wire format from upstream uses strings ("text" / "image"), matching the
 * server's RichTextBlockText / RichTextBlockImage tags from octo-lib.
 */
export const RICH_TEXT_BLOCK_TEXT = "text";
export const RICH_TEXT_BLOCK_IMAGE = "image";

/** Placeholder rendered for an inline image when assembling plain text. */
export const RICH_TEXT_IMAGE_PLACEHOLDER = '[图片]';

/**
 * A single block of a RichText(=14) `content` array. Array order IS the visual
 * text/image interleave order.
 *   - type=text  → uses `text` (plain text; MVP does not render markdown).
 *   - type=image → uses `url` / `width` / `height` (`size`, `name` optional).
 *
 * ⚠️ Naming is locked to the octo-lib `richtext.go` contract: an image block
 * MUST carry width/height > 0 and an http/https `url`; a text block's `text`
 * must be non-empty. This adapter only assembles blocks — the server is the
 * authoritative validator. Never use entities + offset/length here.
 */
export interface RichTextBlock {
  type: typeof RICH_TEXT_BLOCK_TEXT | typeof RICH_TEXT_BLOCK_IMAGE | string;
  /** text block content (required + non-empty when type=text). */
  text?: string;
  /** image block address (required when type=image; scheme http/https only). */
  url?: string;
  /** image block width in px (contract: required + > 0, avoids layout jitter). */
  width?: number;
  /** image block height in px (contract: required + > 0). */
  height?: number;
  /** image block byte size (optional). */
  size?: number;
  /** image block original filename (optional). */
  name?: string;
}

// ─── Forward-payload nested message (MultipleForward children) ──────────────

export interface ForwardUser {
  uid: string;
  name: string;
}

export interface ForwardMessage {
  message_id?: string;
  from_uid: string;
  timestamp?: number;
  payload: {
    type: number;
    content?: string;
    url?: string;
    name?: string;
    users?: ForwardUser[];
    msgs?: ForwardMessage[];
  };
}

