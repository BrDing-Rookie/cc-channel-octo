/**
 * D3 unit tests for the pure doc-task egress predicates. These pin the
 * segment/prefix matching that keeps a legitimate id merely *containing*
 * "doctask" from being mistaken for a doc-task session (which would fail-close
 * normal sends).
 */
import { describe, it, expect } from "vitest";
import {
  DOC_TASK_NON_ROUTABLE_PREFIX,
  DOC_TASK_SESSION_SCOPE_PREFIX,
  docTaskImEgressBlockReason,
  isDocTaskNonRoutableTarget,
  isDocTaskSessionKey,
} from "../doc-task-scope.js";

const SENTINEL = `${DOC_TASK_NON_ROUTABLE_PREFIX}${DOC_TASK_SESSION_SCOPE_PREFIX}d1:70`;

describe("isDocTaskNonRoutableTarget", () => {
  it("matches the bare sentinel and every stacked channel-namespace prefix", () => {
    for (const t of [
      SENTINEL,
      `octo:${SENTINEL}`,
      `channel:octo:${SENTINEL}`,
      `group:${SENTINEL}`,
      `user:${SENTINEL}`,
    ]) {
      expect(isDocTaskNonRoutableTarget(t), t).toBe(true);
    }
  });

  it("does not match a real id that merely contains 'doctask'", () => {
    expect(isDocTaskNonRoutableTarget("octo:u_doctask_fan_001")).toBe(false);
    expect(isDocTaskNonRoutableTarget("group:doctask_team")).toBe(false);
    expect(isDocTaskNonRoutableTarget("user:doctask")).toBe(false);
  });

  it("is false for empty / nullish input", () => {
    expect(isDocTaskNonRoutableTarget("")).toBe(false);
    expect(isDocTaskNonRoutableTarget(undefined)).toBe(false);
    expect(isDocTaskNonRoutableTarget(null)).toBe(false);
  });
});

describe("isDocTaskSessionKey", () => {
  it("matches the doctask scope at a segment boundary (bare and prefixed)", () => {
    expect(isDocTaskSessionKey("doctask:d1:70")).toBe(true);
    expect(isDocTaskSessionKey("octo:doctask-no-im:doctask:d1:70")).toBe(true);
    expect(isDocTaskSessionKey(`octo:${DOC_TASK_SESSION_SCOPE_PREFIX}abc:xyz`)).toBe(true);
  });

  it("does not match a uid/group that merely embeds the substring", () => {
    expect(isDocTaskSessionKey("u_doctask_fan_001")).toBe(false);
    expect(isDocTaskSessionKey("mydoctask:1")).toBe(false); // not at a segment boundary
    expect(isDocTaskSessionKey("")).toBe(false);
    expect(isDocTaskSessionKey(undefined)).toBe(false);
  });
});

describe("docTaskImEgressBlockReason", () => {
  it("returns a reason (naming the tool + the boundary) for a doc-task session", () => {
    const reason = docTaskImEgressBlockReason(`octo:${SENTINEL}`, "octo_message");
    expect(reason).not.toBeNull();
    expect(reason).toContain("octo_message");
    expect(reason).toMatch(/document-comment task sessions/i);
    expect(reason).toMatch(/document comment thread/i);
  });

  it("returns null for a normal IM session (no false positive)", () => {
    expect(docTaskImEgressBlockReason("g1", "octo_message")).toBeNull();
    expect(docTaskImEgressBlockReason("s1_u2", "octo_message")).toBeNull();
    expect(docTaskImEgressBlockReason("u_doctask_fan_001", "octo_message")).toBeNull();
  });
});
