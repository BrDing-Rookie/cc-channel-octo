/**
 * B1/B4–B7 tests: the octo_management tool. Verifies read-only discovery is open,
 * mutating actions are owner-gated + audited, shared-groups is requester-scoped,
 * and resolve applies the disambiguation policy + 30s positive cache.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string }) => ({ type: "sdk", name: opts.name, instance: {} }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

const api = vi.hoisted(() => ({
  fetchBotGroups: vi.fn(),
  getGroupInfo: vi.fn(),
  getGroupMembers: vi.fn(),
  resolveTargetsByName: vi.fn(),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  addGroupMembers: vi.fn(),
  removeGroupMembers: vi.fn(),
  createThread: vi.fn(),
  listThreads: vi.fn(),
  getThread: vi.fn(),
  deleteThread: vi.fn(),
  listThreadMembers: vi.fn(),
  joinThread: vi.fn(),
  leaveThread: vi.fn(),
  searchSpaceMembers: vi.fn(),
  getVoiceContext: vi.fn(),
  updateVoiceContext: vi.fn(),
  deleteVoiceContext: vi.fn(),
}));
vi.mock("../octo/api.js", () => api);

const auditLines: Array<Record<string, unknown>> = [];
vi.mock("../audit.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../audit.js");
  return { ...actual, emitAuditLog: (e: Record<string, unknown>) => auditLines.push(e) };
});

import {
  buildOctoManagementTools,
  OCTO_MANAGEMENT_TOOL_NAME,
  _clearResolveCache,
  type OctoManagementSessionCoords,
  type OctoManagementToolConfig,
} from "../octo-management-tool.js";
import { _clearPermissionCaches } from "../permission.js";

const CONFIG: OctoManagementToolConfig = { apiUrl: "https://x.example.com", botToken: "bf_t" };
const OWNER: OctoManagementSessionCoords = { requesterUid: "own", ownerUid: "own" };
const MEMBER: OctoManagementSessionCoords = { requesterUid: "u1", ownerUid: "own" };

async function invoke(args: Record<string, unknown>, coords: OctoManagementSessionCoords = OWNER) {
  const tools = buildOctoManagementTools(CONFIG, coords);
  const t = tools.find((x) => (x as { name: string }).name === OCTO_MANAGEMENT_TOOL_NAME) as unknown as {
    handler: (a: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  };
  return t.handler(args, {});
}
const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text);

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  auditLines.length = 0;
  _clearResolveCache();
  _clearPermissionCaches();
});

describe("discovery (read-only, open to any requester)", () => {
  it("list-groups returns the bot's groups without an owner gate", async () => {
    api.fetchBotGroups.mockResolvedValue([{ group_no: "g1", name: "A" }]);
    const out = parse(await invoke({ action: "list-groups" }, MEMBER));
    expect(out.total).toBe(1);
    expect(auditLines).toHaveLength(0);
  });

  it("shared-groups returns only groups the requester belongs to", async () => {
    api.fetchBotGroups.mockResolvedValue([{ group_no: "g1", name: "A" }, { group_no: "g2", name: "B" }]);
    api.getGroupMembers.mockImplementation(({ groupNo }: { groupNo: string }) =>
      Promise.resolve(groupNo === "g1" ? [{ uid: "u1", name: "x" }] : [{ uid: "u9", name: "y" }]),
    );
    const out = parse(await invoke({ action: "shared-groups" }, MEMBER));
    expect(out.total).toBe(1);
    expect(out.sharedGroups[0].groupNo).toBe("g1");
  });

  it("group-members requires groupId", async () => {
    const res = await invoke({ action: "group-members" }, MEMBER);
    expect(res.isError).toBe(true);
  });
});

describe("resolve (B5)", () => {
  it("auto-resolves a unique, non-truncated single candidate", async () => {
    api.resolveTargetsByName.mockResolvedValue({
      candidates: [{ kind: "group", channelId: "g1", channelType: 2, name: "Team", groupNo: "g1" }],
      total: 1,
      truncated: false,
    });
    const out = parse(await invoke({ action: "resolve", name: "Team" }, MEMBER));
    expect(out.resolved.channelId).toBe("g1");
  });

  it("returns a candidate list when ambiguous", async () => {
    api.resolveTargetsByName.mockResolvedValue({
      candidates: [
        { kind: "group", channelId: "g1", channelType: 2, name: "Team", groupNo: "g1" },
        { kind: "group", channelId: "g2", channelType: 2, name: "Team", groupNo: "g2" },
      ],
      total: 2,
      truncated: false,
    });
    const out = parse(await invoke({ action: "resolve", name: "Team" }, MEMBER));
    expect(out.resolved).toBeUndefined();
    expect(out.candidates).toHaveLength(2);
  });

  it("caches positive results (one API call within TTL) but not misses", async () => {
    api.resolveTargetsByName.mockResolvedValueOnce({ candidates: [], total: 0, truncated: false });
    await invoke({ action: "resolve", name: "None" }, MEMBER);
    api.resolveTargetsByName.mockResolvedValue({
      candidates: [{ kind: "group", channelId: "g1", channelType: 2, name: "None", groupNo: "g1" }],
      total: 1,
      truncated: false,
    });
    await invoke({ action: "resolve", name: "None" }, MEMBER); // miss not cached → re-queries
    await invoke({ action: "resolve", name: "None" }, MEMBER); // positive now cached
    expect(api.resolveTargetsByName).toHaveBeenCalledTimes(2);
  });
});

describe("mutations (owner-gated + audited)", () => {
  it("denies a non-owner and audits the denial without calling the API", async () => {
    const res = await invoke({ action: "add-members", groupId: "g1", members: ["u9"] }, MEMBER);
    expect(res.isError).toBe(true);
    expect(api.addGroupMembers).not.toHaveBeenCalled();
    expect(auditLines[0]).toMatchObject({ action: "management:add-members", result: "denied" });
  });

  it("allows the owner and audits the grant", async () => {
    api.addGroupMembers.mockResolvedValue({ ok: true, added: 1 });
    const out = parse(await invoke({ action: "add-members", groupId: "g1", members: ["u9"] }, OWNER));
    expect(out.added).toBe(1);
    expect(auditLines[0]).toMatchObject({ action: "management:add-members", result: "allowed" });
  });

  it("create-group requires members + creator", async () => {
    expect((await invoke({ action: "create-group", members: [] }, OWNER)).isError).toBe(true);
    expect((await invoke({ action: "create-group", members: ["u1"] }, OWNER)).isError).toBe(true);
  });

  it("join-thread / leave-thread require groupId + shortId", async () => {
    expect((await invoke({ action: "join-thread", groupId: "g1" }, OWNER)).isError).toBe(true);
    api.joinThread.mockResolvedValue(undefined);
    const out = parse(await invoke({ action: "join-thread", groupId: "g1", shortId: "t1" }, OWNER));
    expect(out.joined).toBe(true);
  });
});

describe("B8: search-members (space-wide people search, read-only)", () => {
  it("searches by keyword and returns members without an owner gate", async () => {
    api.searchSpaceMembers.mockResolvedValue([
      { uid: "u1", name: "Alice", robot: 0 },
      { uid: "u2", name: "Alicia", robot: 0 },
    ]);
    const out = parse(await invoke({ action: "search-members", keyword: "Ali" }, MEMBER));
    expect(out.total).toBe(2);
    expect(out.members[0].uid).toBe("u1");
    expect(api.searchSpaceMembers).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: "Ali", apiUrl: CONFIG.apiUrl, botToken: CONFIG.botToken }),
    );
  });

  it("accepts name as a keyword alias, passes spaceId and limit through", async () => {
    api.searchSpaceMembers.mockResolvedValue([]);
    await invoke({ action: "search-members", name: "Bob", spaceId: "sp1", limit: 5 }, MEMBER);
    expect(api.searchSpaceMembers).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: "Bob", spaceId: "sp1", limit: 5 }),
    );
  });

  it("is NOT audited as a mutation (read-only discovery)", async () => {
    api.searchSpaceMembers.mockResolvedValue([]);
    await invoke({ action: "search-members", keyword: "x" }, MEMBER);
    expect(auditLines).toHaveLength(0);
  });
});

describe("B9: voice-context CRUD (owner-only personal context)", () => {
  it("voice-context-read returns the context for the owner", async () => {
    api.getVoiceContext.mockResolvedValue({ has_context: true, context: "call me Ada", updated_at: "t" });
    const out = parse(await invoke({ action: "voice-context-read" }, OWNER));
    expect(out.has_context).toBe(true);
    expect(out.context).toBe("call me Ada");
  });

  it("voice-context-read is refused for a non-owner (and never calls the API)", async () => {
    const res = await invoke({ action: "voice-context-read" }, MEMBER);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/limited to the bot owner/);
    expect(api.getVoiceContext).not.toHaveBeenCalled();
  });

  it("voice-context-update sets the content for the owner (audited allowed)", async () => {
    api.updateVoiceContext.mockResolvedValue(undefined);
    const out = parse(await invoke({ action: "voice-context-update", content: "  say Octo not otto  " }, OWNER));
    expect(out.updated).toBe(true);
    expect(api.updateVoiceContext).toHaveBeenCalledWith(
      expect.objectContaining({ content: "say Octo not otto" }),
    );
    expect(auditLines.some((l) => l.action === "management:voice-context-update" && l.result === "allowed")).toBe(true);
  });

  it("voice-context-update rejects empty content", async () => {
    const res = await invoke({ action: "voice-context-update", content: "   " }, OWNER);
    expect(res.isError).toBe(true);
    expect(api.updateVoiceContext).not.toHaveBeenCalled();
  });

  it("voice-context-update is denied + audited for a non-owner", async () => {
    const res = await invoke({ action: "voice-context-update", content: "x" }, MEMBER);
    expect(res.isError).toBe(true);
    expect(api.updateVoiceContext).not.toHaveBeenCalled();
    expect(auditLines.some((l) => l.action === "management:voice-context-update" && l.result === "denied")).toBe(true);
  });

  it("voice-context-delete clears the context for the owner", async () => {
    api.deleteVoiceContext.mockResolvedValue(undefined);
    const out = parse(await invoke({ action: "voice-context-delete" }, OWNER));
    expect(out.deleted).toBe(true);
    expect(api.deleteVoiceContext).toHaveBeenCalledTimes(1);
  });

  it("voice-context-delete is denied for a non-owner", async () => {
    const res = await invoke({ action: "voice-context-delete" }, MEMBER);
    expect(res.isError).toBe(true);
    expect(api.deleteVoiceContext).not.toHaveBeenCalled();
  });
});
