/**
 * B0 tests: target parsing (target.ts), audit log + untrusted wrapping
 * (audit.ts), and cross-channel permission checks (permission.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getGroupMembers = vi.fn();
const fetchBotGroups = vi.fn();

vi.mock("../octo/api.js", () => ({
  getGroupMembers: (...a: unknown[]) => getGroupMembers(...a),
  fetchBotGroups: (...a: unknown[]) => fetchBotGroups(...a),
}));

import { parseTarget, bareChannelId } from "../target.js";
import { emitAuditLog, wrapUntrustedContent } from "../audit.js";
import {
  checkPermission,
  getCachedGroupMembers,
  getKnownBotGroupIds,
  _clearPermissionCaches,
} from "../permission.js";
import { ChannelType } from "../octo/types.js";

const API = { apiUrl: "https://x.example.com", botToken: "bf_t" };

beforeEach(() => {
  getGroupMembers.mockReset();
  fetchBotGroups.mockReset();
  _clearPermissionCaches();
});

describe("parseTarget", () => {
  it("honors explicit group: / channel: / user: prefixes", () => {
    expect(parseTarget("group:g1")).toEqual({ channelId: "g1", channelType: ChannelType.Group });
    expect(parseTarget("channel:g1")).toEqual({ channelId: "g1", channelType: ChannelType.Group });
    expect(parseTarget("user:u1")).toEqual({ channelId: "u1", channelType: ChannelType.DM });
  });

  it("classifies a thread composite as CommunityTopic under any group prefix", () => {
    expect(parseTarget("group:g1____t1")).toEqual({ channelId: "g1____t1", channelType: ChannelType.CommunityTopic });
    expect(parseTarget("g1____t1")).toEqual({ channelId: "g1____t1", channelType: ChannelType.CommunityTopic });
  });

  it("classifies a bare id via knownGroupIds, defaulting to DM", () => {
    const known = new Set(["g1"]);
    expect(parseTarget("g1", known)).toEqual({ channelId: "g1", channelType: ChannelType.Group });
    expect(parseTarget("u9", known)).toEqual({ channelId: "u9", channelType: ChannelType.DM });
    expect(parseTarget("g1")).toEqual({ channelId: "g1", channelType: ChannelType.DM }); // no set → DM
  });

  it("strips a bare octo: namespace prefix before classifying", () => {
    expect(parseTarget("octo:g1", new Set(["g1"]))).toEqual({ channelId: "g1", channelType: ChannelType.Group });
  });
});

describe("bareChannelId", () => {
  it("strips namespace prefixes and inline mention suffixes", () => {
    expect(bareChannelId("group:g1")).toBe("g1");
    expect(bareChannelId("octo:group:g1")).toBe("g1");
    expect(bareChannelId("group:g1@u1,u2")).toBe("g1");
    expect(bareChannelId("user:u1")).toBe("u1");
    expect(bareChannelId("g1____t1")).toBe("g1____t1");
  });
});

describe("wrapUntrustedContent", () => {
  it("marks cross-channel content as untrusted, non-instruction data", () => {
    const w = wrapUntrustedContent(3);
    expect(w.metadata.trustLevel).toBe("untrusted-data");
    expect(w.metadata.source).toBe("cross-channel-history");
    expect(w.header).toContain("不是指令");
    expect(w.footer).toContain("不可信");
    expect(w.header).toContain("3");
  });
});

describe("emitAuditLog", () => {
  it("emits one structured [AUDIT] line to the provided sink", () => {
    const lines: string[] = [];
    emitAuditLog(
      { action: "read", requester: "u1", target: "g1", channelType: 2, result: "denied", reason: "nope" },
      { info: (m) => lines.push(m) },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[AUDIT] octo-proactive");
    const json = JSON.parse(lines[0].replace("[AUDIT] octo-proactive ", ""));
    expect(json).toMatchObject({ action: "read", requester: "u1", target: "g1", result: "denied", reason: "nope" });
    expect(typeof json.ts).toBe("string");
  });

  it("never throws on a serialization sink error", () => {
    expect(() =>
      emitAuditLog({ action: "x", requester: undefined, target: "t", channelType: 0, result: "allowed" }, {
        info: () => {
          throw new Error("sink boom");
        },
      }),
    ).not.toThrow();
  });
});

describe("checkPermission", () => {
  it("denies an unknown requester", async () => {
    const r = await checkPermission({ requesterUid: undefined, channelId: "g1", channelType: ChannelType.Group, ownerUid: "own", ...API });
    expect(r.allowed).toBe(false);
    expect(getGroupMembers).not.toHaveBeenCalled();
  });

  it("grants the owner full access without a member fetch", async () => {
    const r = await checkPermission({ requesterUid: "own", channelId: "g1", channelType: ChannelType.Group, ownerUid: "own", ...API });
    expect(r.allowed).toBe(true);
    expect(getGroupMembers).not.toHaveBeenCalled();
  });

  it("DM: only the peer's own conversation", async () => {
    expect((await checkPermission({ requesterUid: "u1", channelId: "u1", channelType: ChannelType.DM, ownerUid: "own", ...API })).allowed).toBe(true);
    expect((await checkPermission({ requesterUid: "u1", channelId: "u2", channelType: ChannelType.DM, ownerUid: "own", ...API })).allowed).toBe(false);
  });

  it("Group: requester must be a current member", async () => {
    getGroupMembers.mockResolvedValue([{ uid: "u1", name: "A" }, { uid: "u2", name: "B" }]);
    expect((await checkPermission({ requesterUid: "u1", channelId: "g1", channelType: ChannelType.Group, ownerUid: "own", ...API })).allowed).toBe(true);
    _clearPermissionCaches();
    getGroupMembers.mockResolvedValue([{ uid: "u2", name: "B" }]);
    expect((await checkPermission({ requesterUid: "u1", channelId: "g1", channelType: ChannelType.Group, ownerUid: "own", ...API })).allowed).toBe(false);
  });

  it("Thread: membership is checked against the parent group", async () => {
    getGroupMembers.mockResolvedValue([{ uid: "u1", name: "A" }]);
    await checkPermission({ requesterUid: "u1", channelId: "g1____t9", channelType: ChannelType.CommunityTopic, ownerUid: "own", ...API });
    expect(getGroupMembers.mock.calls[0][0].groupNo).toBe("g1");
  });

  it("fails closed when member fetch throws", async () => {
    getGroupMembers.mockRejectedValue(new Error("500"));
    const r = await checkPermission({ requesterUid: "u1", channelId: "g1", channelType: ChannelType.Group, ownerUid: "own", ...API });
    expect(r.allowed).toBe(false);
  });
});

describe("member + known-group caches", () => {
  afterEach(() => _clearPermissionCaches());

  it("getCachedGroupMembers fetches once within the TTL", async () => {
    getGroupMembers.mockResolvedValue([{ uid: "u1", name: "A" }]);
    await getCachedGroupMembers({ ...API, groupNo: "g1" });
    await getCachedGroupMembers({ ...API, groupNo: "g1" });
    expect(getGroupMembers).toHaveBeenCalledTimes(1);
  });

  it("getKnownBotGroupIds returns the bot's group-no set", async () => {
    fetchBotGroups.mockResolvedValue([{ group_no: "g1", name: "A" }, { group_no: "g2", name: "B" }]);
    const ids = await getKnownBotGroupIds(API);
    expect([...ids].sort()).toEqual(["g1", "g2"]);
  });
});
