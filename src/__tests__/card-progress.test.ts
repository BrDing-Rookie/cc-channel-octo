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
    setCardContext("s1", CTX);
    // Pure thinking must NOT send a card yet.
    handleAgentEvent("s1", { kind: "thinking", text: "planning" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).not.toHaveBeenCalled();

    // First tool → debounced send.
    handleAgentEvent("s1", { kind: "tool_start", name: "Read", input: { path: "a.ts" }, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1);

    // Tool end + a second tool → edit in place with a monotonic, transient frame.
    handleAgentEvent("s1", { kind: "tool_end", id: "t1", isError: false });
    handleAgentEvent("s1", { kind: "tool_start", name: "Grep", input: {}, id: "t2" });
    await vi.advanceTimersByTimeAsync(900);
    expect(editCardMessage).toHaveBeenCalledTimes(1);
    const editArgs = editCardMessage.mock.calls[0][0];
    expect(editArgs.messageId).toBe("m1");
    expect(editArgs.cardSeq).toBe(1);
    expect(editArgs.transient).toBe(true);
  });

  it("finalize edits a recorded (non-transient) terminal frame", async () => {
    setCardContext("s2", CTX);
    handleAgentEvent("s2", { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    handleAgentEvent("s2", { kind: "tool_end", id: "t1", isError: false });
    await finalizeCard("s2", { success: true });
    const last = editCardMessage.mock.calls.at(-1)![0];
    expect(last.transient).toBeUndefined();
    expect(last.cardSeq).toBeGreaterThanOrEqual(1);
  });

  it("sends no card for a pure-text turn", async () => {
    setCardContext("s3", CTX);
    handleAgentEvent("s3", { kind: "text" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("s3", { success: true });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(editCardMessage).not.toHaveBeenCalled();
  });

  it("emits a terminal card even when the debounce never fired (fast tool turn)", async () => {
    setCardContext("s4", CTX);
    handleAgentEvent("s4", { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    handleAgentEvent("s4", { kind: "tool_end", id: "t1", isError: false });
    // No timer advance: finalize before the 800ms debounce.
    await finalizeCard("s4", { success: true });
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
  });

  it("opens a cooldown on 429 and stops sending frames within the window", async () => {
    sendCardMessage.mockRejectedValueOnce(new Error("Octo API /v1/bot/sendMessage failed (429): slow down"));
    setCardContext("s5", CTX);
    handleAgentEvent("s5", { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1); // the rejected attempt

    // Another event during the cooldown must not fire a new send.
    handleAgentEvent("s5", { kind: "tool_start", name: "Grep", input: {}, id: "t2" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
  });

  it("disables the session on a deterministic 4xx (not 429)", async () => {
    sendCardMessage.mockRejectedValueOnce(new Error("Octo API /v1/bot/sendMessage failed (400): bad card"));
    setCardContext("s6", CTX);
    handleAgentEvent("s6", { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    await vi.advanceTimersByTimeAsync(900);
    // Subsequent events + finalize produce no further network calls.
    handleAgentEvent("s6", { kind: "tool_start", name: "Grep", input: {}, id: "t2" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("s6", { success: true });
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
    expect(editCardMessage).not.toHaveBeenCalled();
  });

  it("a superseding turn on the same session does not disturb the new card", async () => {
    setCardContext("s7", CTX);
    handleAgentEvent("s7", { kind: "tool_start", name: "Read", input: {}, id: "t1" });
    // New turn before the first flush.
    setCardContext("s7", CTX);
    handleAgentEvent("s7", { kind: "tool_start", name: "Bash", input: {}, id: "t9" });
    await vi.advanceTimersByTimeAsync(900);
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
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
