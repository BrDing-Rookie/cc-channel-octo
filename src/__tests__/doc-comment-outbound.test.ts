/**
 * D2 — document-comment outbound dispatch (`postDocReply`).
 *
 * The wire endpoints (`postDocComment` / `postHtmlDocReply`) and the intent→badge
 * mapping (`docReplyStatusOf`) are covered by octo-api-batch0.test.ts. These tests
 * pin the thin dispatch layer: HTML slug vs CRDT docId routing, intent passthrough
 * to the HTML backend, and that `intent` is inert on the CRDT backend (which has
 * no per-comment status field), so a caller uses one signature for both.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const postDocComment = vi.fn();
const postHtmlDocReply = vi.fn();

vi.mock("../octo/api.js", () => ({
  postDocComment: (...a: unknown[]) => postDocComment(...a),
  postHtmlDocReply: (...a: unknown[]) => postHtmlDocReply(...a),
  isPermanentDocCommentFailure: (err: unknown) =>
    err instanceof Error && err.message.includes("permanent"),
}));

import { postDocReply, isPermanentDocCommentFailure } from "../doc-comment-outbound.js";

const BASE = { apiUrl: "https://x.example.com", botToken: "bf_t" } as const;

beforeEach(() => {
  postDocComment.mockReset().mockResolvedValue(undefined);
  postHtmlDocReply.mockReset().mockResolvedValue(undefined);
});

describe("postDocReply routing", () => {
  it("CRDT doc → postDocComment keyed by docId, with parentId, and no HTML call", async () => {
    await postDocReply({
      ...BASE,
      target: { docId: "doc_1", parentId: "7385000000000000123" },
      body: "the answer",
      intent: "final",
    });
    expect(postHtmlDocReply).not.toHaveBeenCalled();
    expect(postDocComment).toHaveBeenCalledTimes(1);
    const arg = postDocComment.mock.calls[0][0];
    expect(arg).toMatchObject({
      apiUrl: BASE.apiUrl,
      botToken: BASE.botToken,
      docId: "doc_1",
      parentId: "7385000000000000123",
      body: "the answer",
    });
    // intent is not part of the CRDT wire contract — it must NOT be forwarded.
    expect(arg).not.toHaveProperty("intent");
  });

  it("CRDT doc with no parentId → root comment (parentId undefined)", async () => {
    await postDocReply({ ...BASE, target: { docId: "doc_1" }, body: "root reply" });
    expect(postDocComment.mock.calls[0][0].parentId).toBeUndefined();
  });

  it("HTML doc → postHtmlDocReply keyed by slug, forwarding the intent, no CRDT call", async () => {
    await postDocReply({
      ...BASE,
      target: { docKind: "html", docId: "slug-abc", parentId: "70" },
      body: "done",
      intent: "progress",
    });
    expect(postDocComment).not.toHaveBeenCalled();
    expect(postHtmlDocReply).toHaveBeenCalledTimes(1);
    expect(postHtmlDocReply.mock.calls[0][0]).toMatchObject({
      slug: "slug-abc",
      parentId: "70",
      body: "done",
      intent: "progress",
    });
  });

  it("HTML doc with no parentId → empty string (backend rejects → visible permanent failure)", async () => {
    await postDocReply({ ...BASE, target: { docKind: "html", docId: "slug-abc" }, body: "x", intent: "notice" });
    expect(postHtmlDocReply.mock.calls[0][0].parentId).toBe("");
    expect(postHtmlDocReply.mock.calls[0][0].intent).toBe("notice");
  });

  it("propagates the AbortSignal to the chosen backend", async () => {
    const signal = AbortSignal.timeout(1000);
    await postDocReply({ ...BASE, target: { docId: "doc_1" }, body: "x", signal });
    expect(postDocComment.mock.calls[0][0].signal).toBe(signal);
  });

  it("does not swallow backend errors (caller classifies + retries)", async () => {
    postDocComment.mockRejectedValueOnce(new Error("Octo API /p failed (503): down"));
    await expect(postDocReply({ ...BASE, target: { docId: "doc_1" }, body: "x" })).rejects.toThrow(/503/);
  });
});

describe("isPermanentDocCommentFailure re-export", () => {
  it("is re-exported so callers import the classifier from one place", () => {
    expect(isPermanentDocCommentFailure(new Error("permanent rejection"))).toBe(true);
    expect(isPermanentDocCommentFailure(new Error("transient 503"))).toBe(false);
  });
});
