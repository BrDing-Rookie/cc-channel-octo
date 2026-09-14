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

describe("queryAgent onActivity (#141 liveness heartbeat)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fires once per drained SDK message — including message types that emit no AgentStreamEvent", async () => {
    // A bare `system` message and a session-id-only message produce no
    // onAgentEvent, but must still count as a "still running" heartbeat so a turn
    // whose only traffic is such messages is not misjudged as idle.
    mockQuery.mockReturnValue(createMockStream([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      { type: "result", subtype: "success" },
    ]));
    let beats = 0;
    const events: AgentStreamEvent[] = [];
    for await (const _ of queryAgent("hi", makeConfig(), undefined, undefined, {
      onAgentEvent: (e) => events.push(e),
      onActivity: () => { beats++; },
    })) {
      void _;
    }
    // One heartbeat per SDK message (5), independent of the 3 AgentStreamEvents
    // those messages happened to emit.
    expect(beats).toBe(5);
  });

  it("a throwing onActivity callback never breaks the stream", async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "result", subtype: "success" },
    ]));
    const chunks: string[] = [];
    for await (const c of queryAgent("hi", makeConfig(), undefined, undefined, {
      onActivity: () => { throw new Error("boom"); },
    })) {
      chunks.push(c);
    }
    expect(chunks.join("")).toBe("hello");
  });
});

// A mock stream whose async iterator pauses `gapMs` after emitting the message at
// `gapAfterIndex` — simulating an SDK stream that goes SILENT while a tool runs
// (or, in the no-tool case, while the model is quiet). Real timers advance during
// the pause, so the LOO-18 heartbeat interval fires (or not) exactly as in prod.
function createPausingStream(
  messages: Array<{ type: string; [k: string]: unknown }>,
  gapAfterIndex: number,
  gapMs: number,
) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (let i = 0; i < messages.length; i++) {
        yield messages[i];
        if (i === gapAfterIndex) await new Promise((r) => setTimeout(r, gapMs));
      }
    },
    close: vi.fn(),
  };
}

describe("queryAgent liveness heartbeat (LOO-18/LOO-19: alive while the turn is still running)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("beats during a long quiet gap WHILE a tool is in-flight (LOO-18 regression)", async () => {
    // tool_use (in-flight) → 120ms of silence → tool_result. With a 20ms heartbeat
    // the beacon must fire several extra times during the gap on top of the
    // per-message beats, so a long tool run never reads as an idle stall.
    mockQuery.mockReturnValue(createPausingStream([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
      { type: "result", subtype: "success" },
    ], /* gapAfterIndex */ 0, /* gapMs */ 120));

    let beats = 0;
    for await (const _ of queryAgent("hi", makeConfig(), undefined, undefined, {
      onActivity: () => { beats++; },
      heartbeatIntervalMs: 20,
    })) { void _; }

    // 3 per-message beats + at least one heartbeat beat across the in-flight gap.
    expect(beats).toBeGreaterThan(3);
  });

  it("beats during a model-wait gap when NO tool is in-flight (LOO-19 fix)", async () => {
    // assistant TEXT (no tool) → 120ms of silence → result. No tool is in-flight,
    // but the SDK iterator is still PENDING (the `result` message has not arrived) —
    // i.e. the turn is healthily waiting on the model. Under LOO-19 that silence
    // must beat (`streamActive`) so the idle watchdog no longer misreads the most
    // common healthy silence as a stall. (Pre-LOO-19 this got exactly 2 beats and
    // produced the false idle timeout this issue fixes.)
    mockQuery.mockReturnValue(createPausingStream([
      { type: "assistant", message: { content: [{ type: "text", text: "thinking done" }] } },
      { type: "result", subtype: "success" },
    ], /* gapAfterIndex */ 0, /* gapMs */ 120));

    let beats = 0;
    for await (const _ of queryAgent("hi", makeConfig(), undefined, undefined, {
      onActivity: () => { beats++; },
      heartbeatIntervalMs: 20,
    })) { void _; }

    // 2 per-message beats + heartbeat beats across the model-wait gap.
    expect(beats).toBeGreaterThan(2);
  });

  it("keeps beating during the model-wait gap AFTER a tool result (LOO-19 fix)", async () => {
    // tool_use → tool_result (tool done) → 120ms quiet → result. After the tool
    // result the in-flight set is empty, but the iterator is still pending (waiting
    // on the model for the final result). Pre-LOO-19 this quiet added no beats (the
    // in-flight-only criterion); under LOO-19 it beats via `streamActive`, because
    // the turn is still running.
    mockQuery.mockReturnValue(createPausingStream([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
      { type: "result", subtype: "success" },
    ], /* gapAfterIndex */ 1, /* gapMs */ 120));

    let beats = 0;
    for await (const _ of queryAgent("hi", makeConfig(), undefined, undefined, {
      onActivity: () => { beats++; },
      heartbeatIntervalMs: 20,
    })) { void _; }

    expect(beats).toBeGreaterThan(3);
  });

  it("stops beating once the SDK stream fully settles (no beat past the last message)", async () => {
    // No gaps: the stream drains straight through. Once the iterator ends,
    // `streamActive` flips false and the heartbeat is cleared in the finally, so a
    // subsequent quiet window (waited here, outside the SDK stream — the router's
    // settle path) adds NO beats. This proves the beat can't outlive the turn and
    // degrade into "never times out"; the (post-settle) idle/total watchdogs then
    // judge the rest.
    mockQuery.mockReturnValue(createMockStream([
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
      { type: "result", subtype: "success" },
    ]));

    let beats = 0;
    for await (const _ of queryAgent("hi", makeConfig(), undefined, undefined, {
      onActivity: () => { beats++; },
      heartbeatIntervalMs: 20,
    })) { void _; }
    const afterStream = beats;
    // Quiet window after the stream has fully settled — no more beats expected.
    await new Promise((r) => setTimeout(r, 80));
    expect(beats).toBe(afterStream);
    expect(beats).toBe(2); // exactly the 2 per-message beats
  });
});
