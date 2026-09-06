import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock only the network calls of octo/api; keep the pure helpers real.
const sendCardMessage = vi.hoisted(() => vi.fn());
const editCardMessage = vi.hoisted(() => vi.fn());
const getCardProfile = vi.hoisted(() => vi.fn());
vi.mock("../octo/api.js", async (importActual) => {
  const actual = await importActual<typeof import("../octo/api.js")>();
  return { ...actual, sendCardMessage, editCardMessage, getCardProfile };
});

import {
  setCardContext,
  handleAgentEvent,
  finalizeCard,
  markStopped,
  reserveTurn,
  isCurrentTurn,
  resolveProgressCardCaps,
  _resetProgressCardsForTests,
  _resetProgressCapsCacheForTests,
  type ProgressCardContext,
} from "../card-progress.js";
import { ChannelType } from "../octo/types.js";

const CTX: ProgressCardContext = {
  apiUrl: "https://octo.example.com",
  botToken: "tok",
  channelId: "chan-1",
  channelType: ChannelType.DM,
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetProgressCardsForTests();
  _resetProgressCapsCacheForTests();
  sendCardMessage.mockResolvedValue({ message_id: "m1" });
  editCardMessage.mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("card-progress state machine", () => {
  it("lazily sends the placeholder only after a real tool step, then edits", async () => {
    const h = setCardContext("s1", CTX);
    // Pure thinking must NOT send a card yet.
    handleAgentEvent(h, { kind: "thinking", text: "planning" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).not.toHaveBeenCalled();

    // First tool → debounced send.
    handleAgentEvent(h, { kind: "tool_start", name: "Read", input: { path: "a.ts" }, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1);

    // Tool end + a second tool → edit in place with a monotonic, transient frame.
    handleAgentEvent(h, { kind: "tool_end", id: "t1", isError: false });
    handleAgentEvent(h, { kind: "tool_start", name: "Grep", input: {}, id: "t2" });
    await vi.advanceTimersByTimeAsync(900);
    expect(editCardMessage).toHaveBeenCalledTimes(1);
    const editArgs = editCardMessage.mock.calls[0][0];
    expect(editArgs.messageId).toBe("m1");
    expect(editArgs.cardSeq).toBe(1);
    expect(editArgs.transient).toBe(true);
  });

  it("finalize edits a recorded (non-transient) terminal frame", async () => {
    const h = setCardContext("s2", CTX);
    handleAgentEvent(h, { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    handleAgentEvent(h, { kind: "tool_end", id: "t1", isError: false });
    await finalizeCard(h, { success: true });
    const last = editCardMessage.mock.calls.at(-1)![0];
    expect(last.transient).toBeUndefined();
    expect(last.cardSeq).toBeGreaterThanOrEqual(1);
  });

  it("sends no card for a pure-text turn", async () => {
    const h = setCardContext("s3", CTX);
    handleAgentEvent(h, { kind: "text" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard(h, { success: true });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(editCardMessage).not.toHaveBeenCalled();
  });

  it("emits a terminal card even when the debounce never fired (fast tool turn)", async () => {
    const h = setCardContext("s4", CTX);
    handleAgentEvent(h, { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    handleAgentEvent(h, { kind: "tool_end", id: "t1", isError: false });
    // No timer advance: finalize before the 800ms debounce.
    await finalizeCard(h, { success: true });
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
  });

  it("opens a cooldown on 429 and stops sending frames within the window", async () => {
    sendCardMessage.mockRejectedValueOnce(new Error("Octo API /v1/bot/sendMessage failed (429): slow down"));
    const h = setCardContext("s5", CTX);
    handleAgentEvent(h, { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1); // the rejected attempt

    // Another event during the cooldown must not fire a new send.
    handleAgentEvent(h, { kind: "tool_start", name: "Grep", input: {}, id: "t2" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
  });

  it("disables the session on a deterministic 4xx (not 429)", async () => {
    sendCardMessage.mockRejectedValueOnce(new Error("Octo API /v1/bot/sendMessage failed (400): bad card"));
    const h = setCardContext("s6", CTX);
    handleAgentEvent(h, { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    // Subsequent events + finalize produce no further network calls.
    handleAgentEvent(h, { kind: "tool_start", name: "Grep", input: {}, id: "t2" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard(h, { success: true });
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
    expect(editCardMessage).not.toHaveBeenCalled();
  });

  it("a superseding turn on the same session does not disturb the new card", async () => {
    const h1 = setCardContext("s7", CTX);
    handleAgentEvent(h1, { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    // New turn before the first flush.
    const h2 = setCardContext("s7", CTX);
    handleAgentEvent(h2, { kind: "tool_start", name: "Bash", input: {}, id: "t9" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
  });
});

describe("turn-generation isolation (dispatch timeout → new turn)", () => {
  it("a timed-out old turn's late stream + finalize never touch the new turn's card", async () => {
    // Turn 1 starts, sends its card, then its dispatch "times out": the handler
    // keeps running in the background while a NEW turn (same session) starts.
    const h1 = setCardContext("iso", CTX);
    handleAgentEvent(h1, { kind: "tool_start", name: "Read", input: {}, id: "a1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1); // turn 1's placeholder (m1)

    // New turn on the same session (dispatch released the lock, turn 1 still alive).
    sendCardMessage.mockResolvedValueOnce({ message_id: "m2" });
    const h2 = setCardContext("iso", CTX);
    handleAgentEvent(h2, { kind: "tool_start", name: "Grep", input: {}, id: "b1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(2);
    expect(sendCardMessage.mock.calls[1][0].channelId).toBe(CTX.channelId);

    editCardMessage.mockClear();
    // Turn 1's ORPHANED stream keeps producing — must NOT edit turn 2's card (m2).
    handleAgentEvent(h1, { kind: "thinking", text: "late" });
    handleAgentEvent(h1, { kind: "tool_start", name: "OldTool", input: {}, id: "a2" });
    handleAgentEvent(h1, { kind: "tool_end", id: "a2", isError: false });
    await vi.advanceTimersByTimeAsync(900);
    // And turn 1's own finalize must not terminate turn 2's card.
    await finalizeCard(h1, { success: true });
    expect(editCardMessage).not.toHaveBeenCalled();

    // Turn 2 still owns its card: its own edits/finalize land on m2.
    handleAgentEvent(h2, { kind: "tool_end", id: "b1", isError: false });
    await finalizeCard(h2, { success: true });
    const edits = editCardMessage.mock.calls;
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits.every((c) => c[0].messageId === "m2")).toBe(true);
  });
});

describe("terminal-state correctness", () => {
  it("a non-success SDK result settles the card as error, not done", async () => {
    const h = setCardContext("err", CTX);
    handleAgentEvent(h, { kind: "tool_start", name: "Bash", input: {}, id: "t1" });
    handleAgentEvent(h, { kind: "tool_end", id: "t1", isError: true });
    // The SDK reports a non-success terminal result (e.g. max turns exhausted).
    handleAgentEvent(h, { kind: "result", isError: true, subtype: "error_max_turns" });
    // Dispatcher finalizes on normal generator completion with success:true — the
    // error result must still win.
    await finalizeCard(h, { success: true });
    const last = editCardMessage.mock.calls.at(-1)?.[0] ?? sendCardMessage.mock.calls.at(-1)![0];
    expect(last.card).toBeDefined();
    // The rendered terminal reflects the error result ("⚠️ Interrupted"), not "✅ Done".
    expect(String(last.plain)).toContain("Interrupted");
    expect(String(last.plain)).not.toContain("Done");
  });

  it("a stopped (dispatch-timeout) turn settles the card as stopped and freezes intake", async () => {
    const h = setCardContext("stp", CTX);
    handleAgentEvent(h, { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1);

    editCardMessage.mockClear();
    // Dispatch timeout marks the turn stopped; the stopped terminal is delivered on
    // the independent lifecycle (recorded, non-transient) right away — no cooldown.
    markStopped(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(editCardMessage).toHaveBeenCalledTimes(1);
    const stopped = editCardMessage.mock.calls.at(-1)![0];
    expect(stopped.transient).toBeUndefined();
    expect(String(stopped.plain)).toContain("Stopped");
    expect(String(stopped.plain)).not.toContain("Done");

    // Intake is frozen: the background stream's late events produce no further sends,
    // and the still-running handler's finalize no-ops (the entry is detached).
    editCardMessage.mockClear();
    handleAgentEvent(h, { kind: "tool_start", name: "LateTool", input: {}, id: "t2" });
    handleAgentEvent(h, { kind: "text" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard(h, { success: true });
    expect(editCardMessage).not.toHaveBeenCalled();
  });
});

describe("terminal frame honors the 429 cooldown", () => {
  it("first send ok → edit 429 → finalize holds the terminal until the window clears, then records it", async () => {
    const h = setCardContext("cd", CTX);
    // First frame sends successfully (m1).
    handleAgentEvent(h, { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1);

    // Next edit is rate-limited → opens the cooldown window.
    editCardMessage.mockRejectedValueOnce(new Error("Octo API /v1/bot/editMessage failed (429): slow down"));
    handleAgentEvent(h, { kind: "tool_start", name: "Grep", input: {}, id: "t2" });
    await vi.advanceTimersByTimeAsync(900);
    expect(editCardMessage).toHaveBeenCalledTimes(1); // the rejected attempt

    // finalize DURING the cooldown must NOT append a request immediately.
    editCardMessage.mockClear();
    handleAgentEvent(h, { kind: "tool_end", id: "t2", isError: false });
    await finalizeCard(h, { success: true });
    expect(editCardMessage).not.toHaveBeenCalled();

    // Once the window clears, the held terminal frame is flushed exactly once and
    // RECORDED (non-transient).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(editCardMessage).toHaveBeenCalledTimes(1);
    expect(editCardMessage.mock.calls[0][0].transient).toBeUndefined();
  });

  it("a second 429 on the terminal frame is retried (not lost) after the window", async () => {
    const h = setCardContext("cd2", CTX);
    handleAgentEvent(h, { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1);

    // Terminal edit is 429'd → held, re-armed for the next window instead of dropped.
    editCardMessage.mockRejectedValueOnce(new Error("Octo API /v1/bot/editMessage failed (429): slow down"));
    handleAgentEvent(h, { kind: "tool_end", id: "t1", isError: false });
    await finalizeCard(h, { success: true });
    expect(editCardMessage).toHaveBeenCalledTimes(1);

    // Window clears → the terminal frame is retried and lands (recorded).
    editCardMessage.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(editCardMessage).toHaveBeenCalledTimes(1);
    expect(editCardMessage.mock.calls[0][0].transient).toBeUndefined();
  });
});

describe("round-2 combination timing", () => {
  it("reserveTurn/isCurrentTurn: a zombie turn that resumes after a newer turn is no longer current", () => {
    // Turn 1 reserves, then (dispatch timeout) a newer turn reserves the same session.
    const t1 = reserveTurn("z");
    const t2 = reserveTurn("z");
    // The newer reservation wins; the zombie turn 1 must decline to install its card.
    expect(isCurrentTurn("z", t1)).toBe(false);
    expect(isCurrentTurn("z", t2)).toBe(true);
    // A never-current empty-key token.
    expect(isCurrentTurn("", reserveTurn(""))).toBe(false);
  });

  it("a superseding turn cannot cancel a stopped terminal that is waiting out a 429 cooldown", async () => {
    const h1 = setCardContext("cx1", CTX);
    handleAgentEvent(h1, { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1); // m1

    // A mid-frame edit is 429'd → opens the cooldown window.
    editCardMessage.mockRejectedValueOnce(new Error("Octo API /v1/bot/editMessage failed (429): slow down"));
    handleAgentEvent(h1, { kind: "tool_start", name: "Grep", input: {}, id: "t2" });
    await vi.advanceTimersByTimeAsync(900);
    editCardMessage.mockClear();

    // Dispatch timeout → stopped. Delivery is HELD by the open cooldown window.
    markStopped(h1);
    await vi.advanceTimersByTimeAsync(0);
    expect(editCardMessage).not.toHaveBeenCalled();

    // Immediate retry: a new turn starts on the SAME session and sends its own card.
    sendCardMessage.mockResolvedValueOnce({ message_id: "m2" });
    const h2 = setCardContext("cx1", CTX);
    handleAgentEvent(h2, { kind: "tool_start", name: "Bash", input: {}, id: "t3" });
    await vi.advanceTimersByTimeAsync(900);

    // Window clears → turn 1's stopped terminal STILL lands on m1 (not cancelled by h2).
    await vi.advanceTimersByTimeAsync(30_000);
    const stoppedEdit = editCardMessage.mock.calls.find((c) => c[0].messageId === "m1");
    expect(stoppedEdit).toBeDefined();
    expect(stoppedEdit![0].transient).toBeUndefined();
    expect(String(stoppedEdit![0].plain)).toContain("Stopped");
  });

  it("a new turn within the 429 window does not drop the previous turn's recorded terminal", async () => {
    const h1 = setCardContext("cx2", CTX);
    handleAgentEvent(h1, { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1); // m1

    // finalize's terminal edit is 429'd → held for retry (detached, independent).
    editCardMessage.mockRejectedValueOnce(new Error("Octo API /v1/bot/editMessage failed (429): slow down"));
    handleAgentEvent(h1, { kind: "tool_end", id: "t1", isError: false });
    await finalizeCard(h1, { success: true });
    expect(editCardMessage).toHaveBeenCalledTimes(1); // the rejected terminal attempt
    editCardMessage.mockClear();

    // A new turn starts on the same session WHILE the cooldown window is still open.
    sendCardMessage.mockResolvedValue({ message_id: "m2" });
    const h2 = setCardContext("cx2", CTX);
    handleAgentEvent(h2, { kind: "tool_start", name: "Grep", input: {}, id: "t2" });
    await vi.advanceTimersByTimeAsync(900);

    // Window clears → turn 1's recorded terminal is retried on m1 (not dropped by h2).
    await vi.advanceTimersByTimeAsync(30_000);
    const termEdit = editCardMessage.mock.calls.find((c) => c[0].messageId === "m1");
    expect(termEdit).toBeDefined();
    expect(termEdit![0].transient).toBeUndefined();
  });

  it("dispatch timeout while the FIRST frame is in flight does not double-send; stopped lands via edit on the same card", async () => {
    // Hold the first (placeholder) send open until we resolve it by hand, so the
    // dispatch timeout lands while that request is still in flight.
    let resolveSend: (v: { message_id: string }) => void = () => {};
    sendCardMessage.mockImplementationOnce(
      () => new Promise<{ message_id: string }>((res) => { resolveSend = res; }),
    );

    const h = setCardContext("df", CTX);
    handleAgentEvent(h, { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    // Debounce fires → runFlush starts the placeholder send; it hangs (unresolved).
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
    expect(editCardMessage).not.toHaveBeenCalled();

    // Dispatch timeout arrives mid-flight → markStopped terminalizes + detaches;
    // deliverTerminal defers because the first-frame send is still inFlight.
    markStopped(h);
    expect(sendCardMessage).toHaveBeenCalledTimes(1); // nothing new sent yet
    expect(editCardMessage).not.toHaveBeenCalled();

    // The original placeholder send finally resolves with its message_id.
    resolveSend({ message_id: "m1" });
    await vi.advanceTimersByTimeAsync(600); // flush finally → deliverTerminal → edit

    // Exactly ONE send total; the recorded stopped terminal is an EDIT on that card.
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
    expect(editCardMessage).toHaveBeenCalledTimes(1);
    const term = editCardMessage.mock.calls[0][0];
    expect(term.messageId).toBe("m1");
    expect(term.transient).toBeUndefined();
    expect(String(term.plain)).toContain("Stopped");
  });
});

describe("resolveProgressCardCaps gating", () => {
  it("enables when display_enabled is advertised", async () => {
    getCardProfile.mockResolvedValue({
      available: true,
      enabled: true,
      config: { card_enabled: true, display_enabled: true, interaction_enabled: false, reasoning_enabled: false, reasoning_template_ref: null },
      elements: ["TextBlock", "Container", "ColumnSet"],
    });
    const r = await resolveProgressCardCaps(CTX.apiUrl, CTX.botToken);
    expect(r.enabled).toBe(true);
    expect(r.caps).toBeDefined();
  });

  it("fails closed when the manifest is unavailable", async () => {
    getCardProfile.mockResolvedValue({ available: false, enabled: false });
    const r = await resolveProgressCardCaps(CTX.apiUrl, CTX.botToken);
    expect(r.enabled).toBe(false);
    expect(r.caps).toBeUndefined();
  });

  it("fails closed (no cache) on a probe error", async () => {
    getCardProfile.mockRejectedValueOnce(new Error("Octo API /v1/bot/card/profile failed (503): down"));
    const first = await resolveProgressCardCaps(CTX.apiUrl, CTX.botToken);
    expect(first.enabled).toBe(false);
    // A negative from a transient error is not cached: the next call re-probes.
    getCardProfile.mockResolvedValue({
      available: true,
      enabled: true,
      config: { card_enabled: true, display_enabled: true, interaction_enabled: false, reasoning_enabled: false, reasoning_template_ref: null },
    });
    const second = await resolveProgressCardCaps(CTX.apiUrl, CTX.botToken);
    expect(second.enabled).toBe(true);
    expect(getCardProfile).toHaveBeenCalledTimes(2);
  });
});
