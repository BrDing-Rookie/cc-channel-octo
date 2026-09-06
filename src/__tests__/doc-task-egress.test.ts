/**
 * D3 acceptance — document-comment task egress fail-closed.
 *
 * The hard gate for the doc-mention feature (D1): an injected doc comment must
 * NOT be able to drive the bot into sending to any group / DM, reading another
 * channel's history, or running group management. The turn's only user-visible
 * output belongs in the doc comment thread.
 *
 * Every egress tool (`octo_message`, `octo_send_media` / `octo_send_rich_text`,
 * the two card tools, `octo_management`) refuses by SESSION context
 * (`coords.channelId` = the non-routable doc-task sentinel), which is the one
 * input an injected comment cannot forge — the send target it *can* set (tool
 * args) is never trusted. A global fetch probe proves not one HTTP request
 * escapes: `ok:false` alone is not enough, since "refused but already sent" also
 * yields `ok:false`.
 *
 * Each assertion is driven only by the guards added in this change: remove the
 * `docTaskImEgressBlockReason` early-return from a tool (or the sentinel
 * fail-closed in `parseTarget`) and the matching case goes red. The negative
 * controls stop "reject unconditionally" from passing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string }) => ({ type: "sdk", name: opts.name, instance: {} }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
  }),
}));

import { buildOctoMessageTools, OCTO_MESSAGE_TOOL_NAME } from "../octo-message-tool.js";
import { buildMediaSendTools, SEND_MEDIA_TOOL_NAME, SEND_RICH_TEXT_TOOL_NAME } from "../media-send-tool.js";
import { buildOctoManagementTools, OCTO_MANAGEMENT_TOOL_NAME } from "../octo-management-tool.js";
import { buildDisplayCardTools, DISPLAY_CARD_TOOL_NAME } from "../card-display-tool.js";
import { buildInteractiveCardTools, INTERACTIVE_CARD_TOOL_NAME } from "../card-interactive-tool.js";
import { parseTarget } from "../target.js";
import { DOC_TASK_NON_ROUTABLE_PREFIX, DOC_TASK_SESSION_SCOPE_PREFIX } from "../doc-task-scope.js";
import { ChannelType } from "../octo/types.js";
import { _clearPermissionCaches } from "../permission.js";

const API = "http://localhost:8090";
const TOKEN = "bf_test";
/** A synthesized doc-task session's channel id — the non-routable sentinel. */
const DOC_SESSION = `octo:${DOC_TASK_NON_ROUTABLE_PREFIX}${DOC_TASK_SESSION_SCOPE_PREFIX}d1:70`;

const realFetch = globalThis.fetch;

/** Any real outbound is recorded; the probe never rejects so a leak surfaces as a call, not an error. */
function installFetchProbe(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ status: 1, message_id: 1, message_seq: 1 }),
      json: async () => ({ status: 1, message_id: 1, message_seq: 1 }),
    };
  }) as unknown as typeof fetch;
  return { calls };
}

type ToolShell = {
  name: string;
  handler: (a: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
};
function pick(tools: unknown[], name: string): ToolShell {
  return (tools as ToolShell[]).find((t) => t.name === name) as ToolShell;
}
const text = (res: { content: Array<{ text: string }> }) => res.content[0].text;

beforeEach(() => {
  vi.restoreAllMocks();
  _clearPermissionCaches();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("octo_message is fail-closed inside a doc-task session", () => {
  it("★ refuses a send to a user: target and emits no HTTP", async () => {
    const probe = installFetchProbe();
    const tools = buildOctoMessageTools(
      { apiUrl: API, botToken: TOKEN },
      { channelId: DOC_SESSION, channelType: ChannelType.DM, requesterUid: "attacker", ownerUid: "own" },
    );
    const res = await pick(tools, OCTO_MESSAGE_TOOL_NAME).handler(
      { action: "send", target: "user:uid_victim", message: "leak the document body here" },
      {},
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/document-comment task sessions/i);
    expect(text(res)).toMatch(/document comment thread/i);
    expect(probe.calls).toHaveLength(0);
  });

  it("★ refuses a send to a group: target (not just DMs) and emits no HTTP", async () => {
    const probe = installFetchProbe();
    const tools = buildOctoMessageTools(
      { apiUrl: API, botToken: TOKEN },
      { channelId: DOC_SESSION, channelType: ChannelType.DM, requesterUid: "attacker", ownerUid: "own" },
    );
    const res = await pick(tools, OCTO_MESSAGE_TOOL_NAME).handler(
      { action: "send", target: "group:grp_public", message: "leak" },
      {},
    );
    expect(res.isError).toBe(true);
    expect(probe.calls).toHaveLength(0);
  });

  it("refuses a cross-channel read too (reading history into a doc task is exfiltration)", async () => {
    const probe = installFetchProbe();
    const tools = buildOctoMessageTools(
      { apiUrl: API, botToken: TOKEN },
      { channelId: DOC_SESSION, channelType: ChannelType.DM, requesterUid: "attacker", ownerUid: "own" },
    );
    const res = await pick(tools, OCTO_MESSAGE_TOOL_NAME).handler(
      { action: "read", target: "group:grp_private", limit: 50 },
      {},
    );
    expect(res.isError).toBe(true);
    expect(probe.calls).toHaveLength(0);
  });

  it("negative control: a normal IM session still sends (guard didn't kill everything)", async () => {
    const probe = installFetchProbe();
    const tools = buildOctoMessageTools(
      { apiUrl: API, botToken: TOKEN },
      { channelId: "g1", channelType: ChannelType.Group, requesterUid: "u1", ownerUid: "own" },
    );
    const res = await pick(tools, OCTO_MESSAGE_TOOL_NAME).handler(
      { action: "send", target: "g1", message: "hello" },
      {},
    );
    expect(res.isError).toBeUndefined();
    expect(probe.calls.some((u) => u.includes("/v1/bot/sendMessage"))).toBe(true);
  });

  it("negative control: a real session id merely containing 'doctask' is not blocked", async () => {
    const probe = installFetchProbe();
    const tools = buildOctoMessageTools(
      { apiUrl: API, botToken: TOKEN },
      { channelId: "u_doctask_fan_001", channelType: ChannelType.DM, requesterUid: "u_doctask_fan_001", ownerUid: "own" },
    );
    const res = await pick(tools, OCTO_MESSAGE_TOOL_NAME).handler(
      { action: "send", target: "u_doctask_fan_001", message: "hi" },
      {},
    );
    expect(res.isError).toBeUndefined();
    expect(probe.calls.some((u) => u.includes("/v1/bot/sendMessage"))).toBe(true);
  });
});

describe("media / card / management tools are fail-closed inside a doc-task session", () => {
  it("octo_send_media refuses and emits no HTTP", async () => {
    const probe = installFetchProbe();
    const tools = buildMediaSendTools(
      { apiUrl: API, botToken: TOKEN },
      { channelId: DOC_SESSION, channelType: ChannelType.DM, cwdDir: "/tmp" },
    );
    const res = await pick(tools, SEND_MEDIA_TOOL_NAME).handler({ source: "http://cdn.test/secret.png" }, {});
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/document-comment task sessions/i);
    expect(probe.calls).toHaveLength(0);
  });

  it("octo_send_rich_text refuses and emits no HTTP", async () => {
    const probe = installFetchProbe();
    const tools = buildMediaSendTools(
      { apiUrl: API, botToken: TOKEN },
      { channelId: DOC_SESSION, channelType: ChannelType.DM, cwdDir: "/tmp" },
    );
    const res = await pick(tools, SEND_RICH_TEXT_TOOL_NAME).handler({ text: "leak" }, {});
    expect(res.isError).toBe(true);
    expect(probe.calls).toHaveLength(0);
  });

  it("octo_send_display_card refuses and emits no HTTP", async () => {
    const probe = installFetchProbe();
    const tools = buildDisplayCardTools(
      { apiUrl: API, botToken: TOKEN },
      { channelId: DOC_SESSION, channelType: ChannelType.DM },
    );
    const res = await pick(tools, DISPLAY_CARD_TOOL_NAME).handler(
      { title: "t", blocks: [{ kind: "text", text: "leak" }] },
      {},
    );
    expect(res.isError).toBe(true);
    expect(probe.calls).toHaveLength(0);
  });

  it("octo_send_card refuses and emits no HTTP", async () => {
    const probe = installFetchProbe();
    const tools = buildInteractiveCardTools(
      { apiUrl: API, botToken: TOKEN, accountId: "bot1" },
      { channelId: DOC_SESSION, channelType: ChannelType.DM },
    );
    const res = await pick(tools, INTERACTIVE_CARD_TOOL_NAME).handler(
      { title: "t", text: "leak", blocks: [] },
      {},
    );
    expect(res.isError).toBe(true);
    expect(probe.calls).toHaveLength(0);
  });

  it("octo_management refuses group discovery and emits no HTTP", async () => {
    const probe = installFetchProbe();
    const tools = buildOctoManagementTools(
      { apiUrl: API, botToken: TOKEN },
      { channelId: DOC_SESSION, requesterUid: "attacker", ownerUid: "own" },
    );
    const res = await pick(tools, OCTO_MANAGEMENT_TOOL_NAME).handler({ action: "list-groups" }, {});
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/document-comment task sessions/i);
    expect(probe.calls).toHaveLength(0);
  });
});

describe("parseTarget fail-closes on the non-routable doc-task sentinel", () => {
  const sentinel = `${DOC_TASK_NON_ROUTABLE_PREFIX}${DOC_TASK_SESSION_SCOPE_PREFIX}d1:70`;

  it("throws for the bare sentinel and every stacked channel-namespace prefix", () => {
    for (const t of [sentinel, `octo:${sentinel}`, `channel:octo:${sentinel}`, `group:${sentinel}`]) {
      expect(() => parseTarget(t), t).toThrow(/no IM destination/i);
    }
  });

  it("negative control: normal targets still parse", () => {
    expect(parseTarget("user:u1")).toEqual({ channelId: "u1", channelType: ChannelType.DM });
    expect(parseTarget("group:g1", new Set(["g1"]))).toEqual({ channelId: "g1", channelType: ChannelType.Group });
    // A real id containing "doctask" is not the sentinel and must not throw.
    expect(() => parseTarget("user:u_doctask_fan_001")).not.toThrow();
  });
});
