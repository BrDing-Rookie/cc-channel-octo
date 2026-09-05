/**
 * B1 / B4–B7: `octo_management` aggregate tool — an in-process MCP server that
 * gives the agent one tool with many actions for group / thread / member
 * discovery and management. Surfaces to the model as
 * `mcp__octo_management__octo_management`.
 *
 * Actions (all wire calls already exist in octo/api.ts, added at batch 0):
 *
 *   Discovery (read-only, open to any requester):
 *     - list-groups          B4  fetchBotGroups
 *     - shared-groups        B4  groups shared between the requester and the bot
 *     - group-info               getGroupInfo
 *     - group-members            getGroupMembers
 *     - resolve              B5  resolveTargetsByName (30s TTL + disambiguation)
 *     - list-threads         B7  listThreads
 *     - get-thread           B7  getThread
 *     - list-thread-members  B7  listThreadMembers
 *
 *   Mutations (owner-gated + audited — see SECURITY below):
 *     - create-group         B6  createGroup
 *     - update-group         B6  updateGroup
 *     - add-members          B6  addGroupMembers
 *     - remove-members       B6  removeGroupMembers
 *     - create-thread            createThread
 *     - delete-thread            deleteThread
 *     - join-thread          B7  joinThread
 *     - leave-thread         B7  leaveThread
 *
 * SECURITY: mutating actions change shared state (group membership, threads), so
 * they are gated to the bot owner uid — the same "防误 (guard against mistakes),
 * not 防攻 (not a hard security boundary)" posture cc already uses for the cron /
 * GROUP.md tools: under bypassPermissions + allowedTools:"*" a determined agent
 * could call the REST API another way, so the real boundary is the bot's tool set
 * (only enable this tool for trusted-context bots). The server ALSO enforces the
 * User-Bot (bf_) token requirement for group/thread management, so an App-Bot
 * token is rejected upstream regardless. Every mutation is audited. Read-only
 * discovery is open — it exposes only what the bot itself can already see, and
 * `shared-groups` is scoped to the requester's own shared groups.
 */
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { TargetCandidate } from "./octo/types.js";
import {
  fetchBotGroups,
  getGroupInfo,
  getGroupMembers,
  resolveTargetsByName,
  createGroup,
  updateGroup,
  addGroupMembers,
  removeGroupMembers,
  createThread,
  listThreads,
  getThread,
  deleteThread,
  listThreadMembers,
  joinThread,
  leaveThread,
} from "./octo/api.js";
import { getCachedGroupMembers } from "./permission.js";
import { emitAuditLog } from "./audit.js";

/** MCP server name; the tool surfaces as `mcp__octo_management__octo_management`. */
export const OCTO_MANAGEMENT_TOOL_SERVER_NAME = "octo_management";
export const OCTO_MANAGEMENT_TOOL_NAME = "octo_management";

const OP_TIMEOUT_MS = 30_000;

/** Actions that mutate shared state — owner-gated + audited. */
const MUTATING_ACTIONS = new Set<string>([
  "create-group",
  "update-group",
  "add-members",
  "remove-members",
  "create-thread",
  "delete-thread",
  "join-thread",
  "leave-thread",
]);

/** 30-second TTL for name→target resolution, matching openclaw's resolve cache. */
const RESOLVE_CACHE_TTL_MS = 30_000;
interface ResolveCacheEntry {
  result: { candidates: TargetCandidate[]; total: number; truncated: boolean };
  expiry: number;
}
const _resolveCache = new Map<string, ResolveCacheEntry>();

/** Visible for tests: clear the resolve-targets cache. */
export function _clearResolveCache(): void {
  _resolveCache.clear();
}

export interface OctoManagementSessionCoords {
  /** uid of the human who drove this turn — subject of the owner gate + audit. */
  requesterUid: string;
  /** Bot owner uid (registerBot.owner_uid); empty string when unknown. */
  ownerUid: string;
}

export interface OctoManagementToolConfig {
  apiUrl: string;
  botToken: string;
}

function jsonResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function errResult(msg: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

const ACTIONS = [
  "list-groups",
  "shared-groups",
  "group-info",
  "group-members",
  "resolve",
  "list-threads",
  "get-thread",
  "list-thread-members",
  "create-group",
  "update-group",
  "add-members",
  "remove-members",
  "create-thread",
  "delete-thread",
  "join-thread",
  "leave-thread",
] as const;

const OCTO_MANAGEMENT_DESCRIPTION =
  "Manage and discover Octo groups, threads, and members. One tool, many actions " +
  "(select via `action`):\n" +
  "DISCOVERY (read-only): list-groups (all groups the bot is in), shared-groups " +
  "(groups you and the bot share), group-info, group-members, resolve (turn a human " +
  "NAME into concrete channel candidates — always resolve before sending, never " +
  "hand-build a target), list-threads, get-thread, list-thread-members.\n" +
  "MANAGEMENT (owner-only): create-group, update-group, add-members, remove-members, " +
  "create-thread, delete-thread, join-thread, leave-thread.\n" +
  "Params by action — groupId: group number (required by most); shortId: thread " +
  "short id (thread actions); members: uid array (create-group/add/remove); creator: " +
  "uid (create-group); name/notice: group fields; threadName: new thread name; keyword " +
  "or name + kind(group|thread|all) + limit: resolve. Management actions require a " +
  "User Bot token and are limited to the bot owner.";

export function buildOctoManagementTools(
  config: OctoManagementToolConfig,
  coords: OctoManagementSessionCoords,
) {
  const isOwner = coords.ownerUid !== "" && coords.requesterUid === coords.ownerUid;

  return [
    tool(
      OCTO_MANAGEMENT_TOOL_NAME,
      OCTO_MANAGEMENT_DESCRIPTION,
      {
        action: z.enum(ACTIONS).describe("The management/discovery action to run."),
        groupId: z.string().optional().describe("Group number (required by most actions)."),
        shortId: z.string().optional().describe("Thread short id (thread actions)."),
        members: z.array(z.string()).optional().describe("uid list (create-group / add / remove)."),
        creator: z.string().optional().describe("Creator uid (create-group)."),
        name: z.string().optional().describe("Group name (create/update-group) or resolve name."),
        notice: z.string().optional().describe("Group notice (update-group)."),
        threadName: z.string().optional().describe("New thread name (create-thread)."),
        keyword: z.string().optional().describe("Resolve keyword (alias for name)."),
        kind: z.enum(["group", "thread", "all"]).optional().describe("Resolve target kind."),
        limit: z.number().int().positive().optional().describe("Resolve result cap."),
      },
      async (args) => {
        const { apiUrl, botToken } = config;
        if (!botToken || !apiUrl) return errResult("Octo account is not fully configured");

        const action = args.action;

        // Owner gate + audit for mutating actions.
        if (MUTATING_ACTIONS.has(action)) {
          if (!isOwner) {
            emitAuditLog({
              action: `management:${action}`,
              requester: coords.requesterUid,
              target: (args.groupId as string | undefined) ?? "",
              channelType: 0,
              result: "denied",
              reason: "owner-only management action",
            });
            return errResult(`action "${action}" is limited to the bot owner`);
          }
          emitAuditLog({
            action: `management:${action}`,
            requester: coords.requesterUid,
            target: (args.groupId as string | undefined) ?? "",
            channelType: 0,
            result: "allowed",
          });
        }

        try {
          switch (action) {
            case "list-groups": {
              const groups = await fetchBotGroups({ apiUrl, botToken });
              return jsonResult({ groups, total: groups.length });
            }

            case "shared-groups": {
              const groups = await fetchBotGroups({ apiUrl, botToken });
              const shared: Array<{ groupNo: string; groupName: string; memberCount: number }> = [];
              for (const g of groups) {
                try {
                  const members = await getCachedGroupMembers({ apiUrl, botToken, groupNo: g.group_no });
                  if (members.some((m) => m.uid === coords.requesterUid)) {
                    shared.push({
                      groupNo: g.group_no,
                      groupName: g.name ?? g.group_no,
                      memberCount: members.length,
                    });
                  }
                } catch {
                  // Skip a group we cannot enumerate; keep scanning the rest.
                }
              }
              return jsonResult({ sharedGroups: shared, total: shared.length });
            }

            case "group-info": {
              const groupId = args.groupId as string | undefined;
              if (!groupId) return errResult("groupId is required for group-info");
              const info = await getGroupInfo({ apiUrl, botToken, groupNo: groupId });
              return jsonResult(info);
            }

            case "group-members": {
              const groupId = args.groupId as string | undefined;
              if (!groupId) return errResult("groupId is required for group-members");
              const members = await getGroupMembers({ apiUrl, botToken, groupNo: groupId });
              return jsonResult({ members, total: members.length });
            }

            case "resolve": {
              const name = ((args.name as string | undefined) ?? (args.keyword as string | undefined))?.trim();
              if (!name) return errResult("name (or keyword) is required for resolve");
              const kind = args.kind as "group" | "thread" | "all" | undefined;
              const limit =
                typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
                  ? Math.floor(args.limit)
                  : undefined;
              return await handleResolve({ apiUrl, botToken, name, kind, limit });
            }

            case "list-threads": {
              const groupId = args.groupId as string | undefined;
              if (!groupId) return errResult("groupId is required for list-threads");
              const threads = await listThreads({ apiUrl, botToken, groupNo: groupId });
              return jsonResult({ threads, total: threads.length });
            }

            case "get-thread": {
              const groupId = args.groupId as string | undefined;
              const shortId = args.shortId as string | undefined;
              if (!groupId || !shortId) return errResult("groupId and shortId are required for get-thread");
              const thread = await getThread({ apiUrl, botToken, groupNo: groupId, shortId });
              return jsonResult(thread);
            }

            case "list-thread-members": {
              const groupId = args.groupId as string | undefined;
              const shortId = args.shortId as string | undefined;
              if (!groupId || !shortId) return errResult("groupId and shortId are required for list-thread-members");
              const members = await listThreadMembers({ apiUrl, botToken, groupNo: groupId, shortId });
              return jsonResult({ members, total: members.length });
            }

            case "create-group": {
              const members = args.members as string[] | undefined;
              if (!members?.length) return errResult("members is required for create-group");
              const creator = args.creator as string | undefined;
              if (!creator) return errResult("creator is required for create-group");
              const result = await createGroup({
                apiUrl,
                botToken,
                name: (args.name as string | undefined) ?? undefined,
                members,
                creator,
                signal: AbortSignal.timeout(OP_TIMEOUT_MS),
              });
              return jsonResult({ created: result });
            }

            case "update-group": {
              const groupId = args.groupId as string | undefined;
              if (!groupId) return errResult("groupId is required for update-group");
              if (args.name === undefined && args.notice === undefined) {
                return errResult("update-group needs at least one of name / notice");
              }
              await updateGroup({
                apiUrl,
                botToken,
                groupNo: groupId,
                name: args.name as string | undefined,
                notice: args.notice as string | undefined,
                signal: AbortSignal.timeout(OP_TIMEOUT_MS),
              });
              return jsonResult({ updated: true, groupId });
            }

            case "add-members": {
              const groupId = args.groupId as string | undefined;
              if (!groupId) return errResult("groupId is required for add-members");
              const members = args.members as string[] | undefined;
              if (!members?.length) return errResult("members is required for add-members");
              const result = await addGroupMembers({
                apiUrl,
                botToken,
                groupNo: groupId,
                members,
                signal: AbortSignal.timeout(OP_TIMEOUT_MS),
              });
              return jsonResult(result);
            }

            case "remove-members": {
              const groupId = args.groupId as string | undefined;
              if (!groupId) return errResult("groupId is required for remove-members");
              const members = args.members as string[] | undefined;
              if (!members?.length) return errResult("members is required for remove-members");
              const result = await removeGroupMembers({
                apiUrl,
                botToken,
                groupNo: groupId,
                members,
                signal: AbortSignal.timeout(OP_TIMEOUT_MS),
              });
              return jsonResult(result);
            }

            case "create-thread": {
              const groupId = args.groupId as string | undefined;
              if (!groupId) return errResult("groupId is required for create-thread");
              const threadName = ((args.threadName as string | undefined) ?? (args.name as string | undefined))?.trim();
              if (!threadName) return errResult("threadName is required for create-thread");
              const thread = await createThread({
                apiUrl,
                botToken,
                groupNo: groupId,
                name: threadName,
                signal: AbortSignal.timeout(OP_TIMEOUT_MS),
              });
              return jsonResult({ created: thread });
            }

            case "delete-thread": {
              const groupId = args.groupId as string | undefined;
              const shortId = args.shortId as string | undefined;
              if (!groupId || !shortId) return errResult("groupId and shortId are required for delete-thread");
              await deleteThread({ apiUrl, botToken, groupNo: groupId, shortId, signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
              return jsonResult({ deleted: true, groupId, shortId });
            }

            case "join-thread": {
              const groupId = args.groupId as string | undefined;
              const shortId = args.shortId as string | undefined;
              if (!groupId || !shortId) return errResult("groupId and shortId are required for join-thread");
              await joinThread({ apiUrl, botToken, groupNo: groupId, shortId, signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
              return jsonResult({ joined: true, groupId, shortId });
            }

            case "leave-thread": {
              const groupId = args.groupId as string | undefined;
              const shortId = args.shortId as string | undefined;
              if (!groupId || !shortId) return errResult("groupId and shortId are required for leave-thread");
              await leaveThread({ apiUrl, botToken, groupNo: groupId, shortId, signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
              return jsonResult({ left: true, groupId, shortId });
            }

            default:
              return errResult(`Unknown action: ${String(action)}`);
          }
        } catch (e) {
          return errResult(e instanceof Error ? e.message : String(e));
        }
      },
    ),
  ];
}

/**
 * Resolve a name into a target, with a 30s positive-result cache and the
 * disambiguation policy from openclaw: a result is auto-resolved ONLY when there
 * is exactly one candidate, total is 1, and it is not truncated; otherwise the
 * candidate list is returned for the agent to disambiguate.
 */
async function handleResolve(params: {
  apiUrl: string;
  botToken: string;
  name: string;
  kind?: "group" | "thread" | "all";
  limit?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  const cacheKey = `${params.name}|${params.kind ?? "all"}|${params.limit ?? "default"}`;
  const cached = _resolveCache.get(cacheKey);
  let result: { candidates: TargetCandidate[]; total: number; truncated: boolean };
  if (cached && cached.expiry > Date.now()) {
    result = cached.result;
  } else {
    result = await resolveTargetsByName({
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      name: params.name,
      kind: params.kind,
      limit: params.limit,
    });
    // Only cache POSITIVE results, so a freshly created target is not masked by a
    // cached miss for 30s.
    if (result.candidates.length > 0) {
      _resolveCache.set(cacheKey, { result, expiry: Date.now() + RESOLVE_CACHE_TTL_MS });
    }
  }

  const { candidates, total, truncated } = result;
  if (candidates.length === 0) {
    return jsonResult({ resolved: null, candidates: [], total: 0, error: `No target named "${params.name}" found` });
  }
  if (candidates.length === 1 && total === 1 && truncated !== true) {
    return jsonResult({ resolved: candidates[0] });
  }
  return jsonResult({ candidates, total, truncated });
}

/** Build the octo_management MCP server for one agent turn. */
export function createOctoManagementToolServer(
  config: OctoManagementToolConfig,
  coords: OctoManagementSessionCoords,
) {
  return createSdkMcpServer({
    name: OCTO_MANAGEMENT_TOOL_SERVER_NAME,
    version: "1.0.0",
    tools: buildOctoManagementTools(config, coords),
  });
}
