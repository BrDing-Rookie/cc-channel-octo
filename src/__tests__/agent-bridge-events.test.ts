import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));
vi.mock("../skill-linker.js", () => ({ linkSkillsIntoSandbox: vi.fn() }));
vi.mock("../cwd-resolver.js", () => ({
  resolveSessionCwd: (cwdBase: string, ctx: { kind: string; sessionKey: string }) =>
    `${cwdBase}/${ctx.kind}-${ctx.sessionKey}`,
}));

import { queryAgent, type AgentStreamEvent } from "../agent-bridge.js";
import type { Config } from "../config.js";

function makeConfig(): Config {
  return {
    botToken: "t",
    apiUrl: "https://test.example.com",
    cwd: "/tmp/test",
    dataDir: "/tmp/data",
    sdk: { allowedTools: ["Read"], permissionMode: "bypassPermissions", settingSources: ["user"] },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
  } as Config;
}

function createMockStream(messages: Array<{ type: string; [k: string]: unknown }>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const m of messages) yield m;
    },
    close: vi.fn(),
  };
}

async function drain(events: AgentStreamEvent[]): Promise<void> {
  for await (const _ of queryAgent("hi", makeConfig(), undefined, undefined, {
    onAgentEvent: (e) => events.push(e),
  })) {
    void _;
  }
}

describe("queryAgent onAgentEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits thinking / tool_start / text / result in stream order", async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "let me look", signature: "sig" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
      { type: "result", subtype: "success" },
    ]));
    const events: AgentStreamEvent[] = [];
    await drain(events);
    expect(events).toEqual([
      { kind: "thinking", text: "let me look", signed: true },
      { kind: "tool_start", name: "Read", input: { path: "a.ts" }, id: "t1" },
      { kind: "tool_end", id: "t1", isError: false },
      { kind: "text" },
      { kind: "result", isError: false, subtype: "success" },
    ]);
  });

  it("marks redacted_thinking blocks without leaking data", async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: "assistant", message: { content: [{ type: "redacted_thinking", data: "ENCRYPTED" }] } },
    ]));
    const events: AgentStreamEvent[] = [];
    await drain(events);
    expect(events).toEqual([{ kind: "thinking", redacted: true }]);
  });

  it("marks a failed tool_result as an error, and a non-success result", async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true }] } },
      { type: "result", subtype: "error_max_turns" },
    ]));
    const events: AgentStreamEvent[] = [];
    await drain(events);
    expect(events).toContainEqual({ kind: "tool_end", id: "t2", isError: true });
    expect(events).toContainEqual({ kind: "result", isError: true, subtype: "error_max_turns" });
  });
});
