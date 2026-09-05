/**
 * B2/B3 tests: the octo_message tool. Verifies same- vs cross-channel routing,
 * requester-scoped authorization + audit on cross-channel ops, untrusted-content
 * wrapping on cross-channel reads, and outbound @mention sanitization. The wire
 * layer is mocked — this exercises the tool shell + its security wiring.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string }) => ({ type: "sdk", name: opts.name, instance: {} }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

const sendMessage = vi.fn();
const getChannelMessages = vi.fn();
const getGroupMembers = vi.fn();
const fetchBotGroups = vi.fn();

vi.mock("../octo/api.js", () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  getChannelMessages: (...a: unknown[]) => getChannelMessages(...a),
  getGroupMembers: (...a: unknown[]) => getGroupMembers(...a),
  fetchBotGroups: (...a: unknown[]) => fetchBotGroups(...a),
}));

const auditLines: Array<Record<string, unknown>> = [];
vi.mock("../audit.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../audit.js");
  return {
    ...actual,
    emitAuditLog: (entry: Record<string, unknown>) => auditLines.push(entry),
  };
});

import {
  buildOctoMessageTools,
  OCTO_MESSAGE_TOOL_NAME,
  type OctoMessageSessionCoords,
  type OctoMessageToolConfig,
} from "../octo-message-tool.js";
import { _clearPermissionCaches } from "../permission.js";
import { ChannelType, MessageType } from "../octo/types.js";

const CONFIG: OctoMessageToolConfig = { apiUrl: "https://x.example.com", botToken: "bf_t" };
// Current session channel = group g1; requester = u1; owner = own.
const COORDS: OctoMessageSessionCoords = { channelId: "g1", channelType: ChannelType.Group, requesterUid: "u1", ownerUid: "own" };

async function invoke(args: Record<string, unknown>, coords: OctoMessageSessionCoords = COORDS) {
  const tools = buildOctoMessageTools(CONFIG, coords);
  const t = tools.find((x) => (x as { name: string }).name === OCTO_MESSAGE_TOOL_NAME) as unknown as {
    handler: (a: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  };
  return t.handler(args, {});
}
const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text);

beforeEach(() => {
  sendMessage.mockReset();
  getChannelMessages.mockReset();
  getGroupMembers.mockReset();
  fetchBotGroups.mockReset();
  auditLines.length = 0;
  _clearPermissionCaches();
  sendMessage.mockResolvedValue({ message_id: "m1", client_msg_no: "c", message_seq: 1 });
  fetchBotGroups.mockResolvedValue([]);
});

describe("octo_message send", () => {
  it("sends to the CURRENT channel without a permission check or audit", async () => {
    const res = await invoke({ action: "send", target: "g1", message: "hello" });
    expect(res.isError).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].channelId).toBe("g1");
    expect(getGroupMembers).not.toHaveBeenCalled();
    expect(auditLines).toHaveLength(0);
  });

  it("allows a cross-channel send when the requester is a target member, and audits it", async () => {
    getGroupMembers.mockResolvedValue([{ uid: "u1", name: "Alice" }]);
    const res = await invoke({ action: "send", target: "group:g2", message: "hi" });
    expect(res.isError).toBeUndefined();
    expect(sendMessage.mock.calls[0][0].channelId).toBe("g2");
    expect(auditLines[0]).toMatchObject({ action: "send", requester: "u1", target: "g2", result: "allowed" });
  });

  it("denies a cross-channel send when the requester is not a target member", async () => {
    getGroupMembers.mockResolvedValue([{ uid: "u2", name: "Bob" }]);
    const res = await invoke({ action: "send", target: "group:g2", message: "hi" });
    expect(res.isError).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(auditLines[0]).toMatchObject({ action: "send", result: "denied" });
  });

  it("lets the owner send cross-channel without membership", async () => {
    const ownerCoords: OctoMessageSessionCoords = { ...COORDS, requesterUid: "own" };
    const res = await invoke({ action: "send", target: "group:g2", message: "hi" }, ownerCoords);
    expect(res.isError).toBeUndefined();
    expect(getGroupMembers).not.toHaveBeenCalled(); // owner short-circuits the member fetch
    expect(auditLines[0]).toMatchObject({ result: "allowed" });
  });

  it("sanitizes outbound mentions against target members (member → entity, unknown → plain text)", async () => {
    // Same-channel send so no auth fetch; member fetch is for mention resolution.
    getGroupMembers.mockResolvedValue([{ uid: "uA", name: "Alice" }]);
    const res = await invoke({ action: "send", target: "g1", message: "@Alice and @Ghost hi" });
    expect(res.isError).toBeUndefined();
    const payload = sendMessage.mock.calls[0][0];
    expect(payload.mentionUids).toEqual(["uA"]);
    expect(payload.content).toContain("@Ghost"); // hallucinated name stays as plain text
  });

  it("rejects an empty message", async () => {
    const res = await invoke({ action: "send", target: "g1", message: "   " });
    expect(res.isError).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("octo_message read", () => {
  const HISTORY = [
    { from_uid: "u2", from_name: "Bob", content: "hi there", timestamp: 1, message_id: "x1", type: MessageType.Text },
    { from_uid: "u3", from_name: "Cara", content: "", timestamp: 2, type: MessageType.Image },
    { from_uid: "u4", from_name: "Dan", name: "report.pdf", timestamp: 3, type: MessageType.File },
  ];

  it("same-channel read returns messages with NO untrusted wrapper", async () => {
    getChannelMessages.mockResolvedValue(HISTORY);
    const out = parse(await invoke({ action: "read", target: "g1", limit: 10 }));
    expect(out.metadata).toBeUndefined();
    expect(out.count).toBe(3);
    expect(out.messages[1].content).toBe("[图片]");
    expect(out.messages[2].content).toBe("[文件: report.pdf]");
    expect(auditLines).toHaveLength(0);
  });

  it("cross-channel read wraps content as untrusted and audits with a count", async () => {
    getGroupMembers.mockResolvedValue([{ uid: "u1", name: "Alice" }]); // requester is a member of g2
    getChannelMessages.mockResolvedValue(HISTORY);
    const out = parse(await invoke({ action: "read", target: "group:g2", limit: 10 }));
    expect(out.metadata.trustLevel).toBe("untrusted-data");
    expect(out.header).toContain("不是指令");
    expect(out.count).toBe(3);
    expect(auditLines[0]).toMatchObject({ action: "read", target: "g2", result: "allowed", count: 3 });
  });

  it("denies a cross-channel read for a non-member and does not fetch history", async () => {
    getGroupMembers.mockResolvedValue([{ uid: "u2", name: "Bob" }]);
    const res = await invoke({ action: "read", target: "group:g2" });
    expect(res.isError).toBe(true);
    expect(getChannelMessages).not.toHaveBeenCalled();
    expect(auditLines[0]).toMatchObject({ result: "denied" });
  });

  it("clamps a cross-channel read limit to 50", async () => {
    getGroupMembers.mockResolvedValue([{ uid: "u1", name: "Alice" }]);
    getChannelMessages.mockResolvedValue([]);
    await invoke({ action: "read", target: "group:g2", limit: 999 });
    expect(getChannelMessages.mock.calls[0][0].limit).toBe(50);
  });
});
