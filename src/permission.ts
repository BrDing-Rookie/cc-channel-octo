/**
 * B0: permission checking for cross-channel proactive-message operations
 * (B2 send / B3 read), plus the small TTL caches those checks need.
 *
 * Ported and adapted from openclaw-channel-octo `permission.ts` +
 * `member-cache.ts`. Adaptation to cc's runtime:
 *   - cc has a single owner uid per bot (`registerBot.owner_uid`, surfaced as
 *     `router.getOwnerUid()`), not openclaw's per-account owner registry — so the
 *     owner check is a plain uid compare, no accountId.
 *   - cc's `GroupContext` member cache is scoped to the CURRENT channel, so for
 *     an ARBITRARY target group we fetch members through a dedicated short-TTL
 *     cache here rather than reusing GroupContext.
 *
 * Rules (mirror openclaw):
 *   - Owner → full access.
 *   - DM     → requester may only touch their own conversation with the bot.
 *   - Group  → requester must be a current member of the group.
 *   - Thread → requester must be a current member of the PARENT group.
 *   - Unknown requester / unsupported channel type → denied.
 */
import { ChannelType } from "./octo/types.js";
import { extractParentGroupNo } from "./octo/channel-id.js";
import { getGroupMembers, fetchBotGroups, type GroupMember } from "./octo/api.js";

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

/** 5-minute member cache, matching openclaw's member-cache TTL. */
const MEMBER_CACHE_TTL_MS = 5 * 60 * 1000;
/** 60-second cache for the bot's own group list (used for bare-id classification). */
const KNOWN_GROUPS_TTL_MS = 60 * 1000;

interface MemberCacheEntry {
  members: GroupMember[];
  expiry: number;
}
const _memberCache = new Map<string, MemberCacheEntry>();

interface KnownGroupsEntry {
  ids: Set<string>;
  expiry: number;
}
// Keyed by botToken so multi-bot processes don't cross-contaminate.
const _knownGroupsCache = new Map<string, KnownGroupsEntry>();

/** Visible for tests: drop every cached entry. */
export function _clearPermissionCaches(): void {
  _memberCache.clear();
  _knownGroupsCache.clear();
}

/**
 * Fetch a group's members with a 5-minute TTL cache. Throws on API failure so a
 * caller can fail closed rather than silently treating a fetch error as
 * "not a member" (which would be a false denial) or "member" (a false grant).
 */
export async function getCachedGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
}): Promise<GroupMember[]> {
  const cached = _memberCache.get(params.groupNo);
  if (cached && cached.expiry > Date.now()) return cached.members;
  const members = await getGroupMembers({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupNo,
  });
  _memberCache.set(params.groupNo, { members, expiry: Date.now() + MEMBER_CACHE_TTL_MS });
  return members;
}

/**
 * The set of group numbers the bot belongs to, cached for 60s. Best-effort:
 * `fetchBotGroups` never throws (returns `[]` on failure), so a transient error
 * degrades to an empty set — bare ids then classify as DMs, which fail closed
 * for group operations rather than mis-routing.
 */
export async function getKnownBotGroupIds(params: {
  apiUrl: string;
  botToken: string;
}): Promise<Set<string>> {
  const cached = _knownGroupsCache.get(params.botToken);
  if (cached && cached.expiry > Date.now()) return cached.ids;
  const groups = await fetchBotGroups({ apiUrl: params.apiUrl, botToken: params.botToken });
  const ids = new Set(groups.map((g) => g.group_no).filter(Boolean));
  _knownGroupsCache.set(params.botToken, { ids, expiry: Date.now() + KNOWN_GROUPS_TTL_MS });
  return ids;
}

/**
 * Authorize `requesterUid` (the human who drove the current turn) to read/send
 * against `channelId`/`channelType`. On any membership-fetch error this fails
 * closed (denied) — a proactive cross-channel op must never be allowed on the
 * back of an unverifiable membership claim.
 */
export async function checkPermission(params: {
  requesterUid: string | undefined;
  channelId: string;
  channelType: number;
  ownerUid: string | undefined;
  apiUrl: string;
  botToken: string;
}): Promise<PermissionResult> {
  const { requesterUid, channelId, channelType, ownerUid } = params;

  if (!requesterUid) {
    return { allowed: false, reason: "无法识别调用者身份" };
  }

  // Owner gets full access.
  if (ownerUid && ownerUid !== "" && requesterUid === ownerUid) {
    return { allowed: true };
  }

  if (channelType === ChannelType.DM) {
    // DM: only your own conversation with the bot (channelId is the peer uid).
    if (channelId !== requesterUid) {
      return { allowed: false, reason: "无权访问他人与 Bot 的私信" };
    }
    return { allowed: true };
  }

  if (channelType === ChannelType.Group || channelType === ChannelType.CommunityTopic) {
    // For a thread, membership is checked against the PARENT group.
    const groupNo = extractParentGroupNo(channelId);
    if (!groupNo) {
      return { allowed: false, reason: "无效的频道 ID" };
    }
    let members: GroupMember[];
    try {
      members = await getCachedGroupMembers({
        apiUrl: params.apiUrl,
        botToken: params.botToken,
        groupNo,
      });
    } catch {
      // Fail closed: cannot verify membership → deny.
      return { allowed: false, reason: "无法校验群成员身份，已拒绝" };
    }
    const isMember = members.some((m) => m.uid === requesterUid);
    if (!isMember) {
      return { allowed: false, reason: "你不在该群中，无权访问" };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: `不支持的频道类型: ${channelType}` };
}
