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
