import { describe, it, expect } from "vitest";
import {
  NO_SUMMARY_THOUGHT,
  REDACTED_THOUGHT,
  THOUGHT_MAX,
  noSummaryThought,
  resolveReasoningThought,
  sanitizeReasoningThought,
} from "../reasoning-thought.js";

describe("resolveReasoningThought — 4-state classification", () => {
  it("classifies clean text as `text`", () => {
    const r = resolveReasoningThought("Let me read the config file to understand the layout.");
    expect(r.kind).toBe("text");
    expect(r.text).toBe("Let me read the config file to understand the layout.");
  });

  it("classifies empty / whitespace / undefined as `none` with empty text", () => {
    expect(resolveReasoningThought(undefined).kind).toBe("none");
    expect(resolveReasoningThought("").kind).toBe("none");
    expect(resolveReasoningThought("   \n\t ").kind).toBe("none");
    expect(resolveReasoningThought("").text).toBe("");
  });

  it("collapses control chars + whitespace before classifying", () => {
    const r = resolveReasoningThought("plan:   step\tone\n\n  two");
    expect(r.kind).toBe("text");
    expect(r.text).toBe("plan: step one two");
  });

  it("emits the no-summary state via noSummaryThought()", () => {
    const r = noSummaryThought();
    expect(r.kind).toBe("no-summary");
    expect(r.text).toBe(NO_SUMMARY_THOUGHT);
  });

  it("redacts a thought that trips the sensitive-data detector", () => {
    // A long high-entropy token-shaped string trips the generic detector.
    const r = resolveReasoningThought("the key is sk-abcdEFGH1234ijklMNOP5678qrstUVWX9012yzAB3456");
    expect(r.kind).toBe("redacted");
    expect(r.text).toBe(REDACTED_THOUGHT);
  });

  it("redacts an internal-context marker even with obfuscated filler", () => {
    expect(resolveReasoningThought("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> secrets").kind).toBe("redacted");
    expect(resolveReasoningThought("prefix <<<~BEGIN~~INTERNAL data").kind).toBe("redacted");
  });

  it("never leaks a raw URL: a URL-bearing thought is reduced or withheld", () => {
    const r = resolveReasoningThought("see https://internal.example.com/secret/path?token=abc");
    expect(r.text).not.toContain("token=abc");
    expect(["text", "redacted"]).toContain(r.kind);
  });

  it("truncates an over-long clean thought to THOUGHT_MAX + ellipsis", () => {
    // Natural words (with spaces) so the entropy/base64 detector is not tripped.
    const long = Array(120).fill("review").join(" ");
    expect(long.length).toBeGreaterThan(THOUGHT_MAX);
    const r = resolveReasoningThought(long);
    expect(r.kind).toBe("text");
    expect(r.text.endsWith("…")).toBe(true);
    expect([...r.text].length).toBe(THOUGHT_MAX + 1);
  });

  it("sanitizeReasoningThought returns the display string", () => {
    expect(sanitizeReasoningThought("hello")).toBe("hello");
    expect(sanitizeReasoningThought("")).toBe("");
  });
});
