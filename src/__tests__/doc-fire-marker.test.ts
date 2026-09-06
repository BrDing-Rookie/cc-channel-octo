/**
 * D1 hard-gate #1: `_docTask` is honored only with a matching per-process nonce.
 * A forged inbound payload can set the key + a wrong/absent nonce and must NOT
 * pass — otherwise it could steer the bot's postDocReply at an attacker docId.
 */
import { describe, it, expect } from "vitest";
import { DOC_FIRE_NONCE, DOC_FIRE_NONCE_KEY, DOC_TASK_PAYLOAD_KEY, isAuthenticDocFire } from "../doc-fire-marker.js";

const ctx = { docId: "d1", threadId: "70", sessionScope: "doctask:d1:70" };

describe("isAuthenticDocFire", () => {
  it("true only when _docTask is present AND the nonce matches", () => {
    expect(
      isAuthenticDocFire({ [DOC_TASK_PAYLOAD_KEY]: ctx, [DOC_FIRE_NONCE_KEY]: DOC_FIRE_NONCE }),
    ).toBe(true);
  });

  it("false when the nonce is wrong or absent (forged inbound payload)", () => {
    expect(isAuthenticDocFire({ [DOC_TASK_PAYLOAD_KEY]: ctx, [DOC_FIRE_NONCE_KEY]: "deadbeef" })).toBe(false);
    expect(isAuthenticDocFire({ [DOC_TASK_PAYLOAD_KEY]: ctx })).toBe(false);
  });

  it("false when _docTask is missing even with a valid nonce", () => {
    expect(isAuthenticDocFire({ [DOC_FIRE_NONCE_KEY]: DOC_FIRE_NONCE })).toBe(false);
  });

  it("false for empty / nullish payloads", () => {
    expect(isAuthenticDocFire(undefined)).toBe(false);
    expect(isAuthenticDocFire(null)).toBe(false);
    expect(isAuthenticDocFire({})).toBe(false);
  });
});
