/**
 * B2/B3: outbound/cross-channel target parsing.
 *
 * Ported and trimmed from openclaw-channel-octo `target.ts`. Dependency-free
 * (only `octo/types` + `octo/channel-id`) so both the message tool and the
 * permission layer can classify a target without pulling in the tool modules.
 *
 * A target string names a channel or user the agent wants to reach:
 *   - `group:<id>`   → a group (or CommunityTopic thread when `<id>` contains
 *                      the `____` thread separator).
 *   - `channel:<id>` → alias for `group:` (some delivery paths emit this).
 *   - `user:<uid>`   → a direct message to `<uid>`.
 *   - `<groupNo>____<shortId>` → a thread (CommunityTopic).
 *   - bare `<id>`    → classified via `knownGroupIds`: a known group → Group,
 *                      otherwise a DM to that uid.
 *
 * Explicit prefixes always win over the bare-id heuristic. `octo:` is a
 * namespace prefix with no user/group semantics and is stripped before
 * classification (never defaulted to a group — a DM id sent as channel_type=2
 * is rejected by the server).
 */
import { ChannelType } from "./octo/types.js";
import { THREAD_ID_SEPARATOR } from "./octo/channel-id.js";
import { isDocTaskNonRoutableTarget } from "./doc-task-scope.js";

export interface ParsedTarget {
  channelId: string;
  channelType: ChannelType;
}

/** Strip a leading `octo:` / `channel:` / `group:` run (NOT `user:`). */
function stripGroupNamespacePrefixes(target: string): string {
  let s = target;
  // Collapse repeated/stacked leading namespace prefixes ("octo:group:x").
  // `user:` is intentionally preserved — it carries DM semantics.
  for (;;) {
    if (s.startsWith("octo:")) s = s.slice(5);
    else if (s.startsWith("channel:")) s = s.slice(8);
    else if (s.startsWith("group:")) s = s.slice(6);
    else break;
  }
  return s;
}

/**
 * Parse a target string into `{ channelId, channelType }`.
 *
 * `knownGroupIds`, when supplied, is the set of group numbers the bot belongs to
 * (see permission.getKnownBotGroupIds). It only affects bare-id classification —
 * a bare id in the set is a Group, otherwise a DM.
 */
export function parseTarget(target: string, knownGroupIds?: Set<string>): ParsedTarget {
  const trimmed = target.trim();

  // D3 fail-closed: the doc-task session's channel id is a non-routable sentinel
  // (see doc-task-scope.ts). It must never resolve to any real channel — a doc
  // task's output belongs in the comment thread, never IM. Throwing here at the
  // single outbound-target resolver means any code that tries to route the
  // session channel as an IM destination (now or a future outbound path) fails
  // loud instead of leaking, rather than each send site re-implementing a guard.
  if (isDocTaskNonRoutableTarget(trimmed)) {
    throw new Error(
      "octo: document-comment task sessions have no IM destination — replies must go to the doc comment thread, not a chat target",
    );
  }

  // Explicit group/channel prefix always wins.
  if (trimmed.startsWith("group:") || trimmed.startsWith("channel:")) {
    const channelId = trimmed.startsWith("group:") ? trimmed.slice(6) : trimmed.slice(8);
    return {
      channelId,
      channelType: channelId.includes(THREAD_ID_SEPARATOR)
        ? ChannelType.CommunityTopic
        : ChannelType.Group,
    };
  }
  if (trimmed.startsWith("user:")) {
    return { channelId: trimmed.slice(5), channelType: ChannelType.DM };
  }

  // Strip a bare `octo:` namespace prefix, then classify.
  let bareId = trimmed;
  if (bareId.startsWith("octo:")) bareId = bareId.slice(5);

  if (bareId.includes(THREAD_ID_SEPARATOR)) {
    return { channelId: bareId, channelType: ChannelType.CommunityTopic };
  }

  const isGroup = knownGroupIds?.has(bareId) ?? false;
  return { channelId: bareId, channelType: isGroup ? ChannelType.Group : ChannelType.DM };
}

/**
 * Canonical bare channel id of a target, with every namespace prefix removed and
 * any inline `@uid,uid` mention suffix on a group target dropped. Used to decide
 * whether a resolved target is the SAME channel as the current session (so the
 * cross-channel permission gate is skipped for own-channel operations).
 */
export function bareChannelId(target: string): string {
  const s = stripGroupNamespacePrefixes(target.trim());
  if (s.startsWith("user:")) return s.slice(5);
  const at = s.indexOf("@");
  return at >= 0 ? s.slice(0, at) : s;
}
