/**
 * D1 — doc-mention handler orchestration: dedupe claim/complete/release, the
 * fallback notice when the user is left hanging, and the dead-letter (with
 * permanent-vs-transient classification, gate #3) when both the answer and the
 * notice fail. The dispatch mock mirrors what handleMessage's doc fork does:
 * read the `_docTask` ctx, call postComment('final'), then reportTurn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const postDocReply = vi.fn();
const isPermanentDocCommentFailure = vi.fn();
vi.mock("../doc-comment-outbound.js", () => ({
  postDocReply: (...a: unknown[]) => postDocReply(...a),
  isPermanentDocCommentFailure: (e: unknown) => isPermanentDocCommentFailure(e),
}));

import { createDocMentionHandler, type DocMentionDispatch } from "../doc-mention-handler.js";
import { createMemoryDocMentionDedupeStore } from "../doc-mention-dedupe.js";
import { createMemoryDocTaskDeadLetterStore } from "../doc-task-deadletter.js";
import { docTaskDedupeKey, type DocCommentMention, type DocTaskContext } from "../doc-mention.js";
import { DOC_TASK_PAYLOAD_KEY } from "../doc-fire-marker.js";
import type { BotMessage } from "../octo/types.js";

const MENTION: DocCommentMention = {
  eventId: 5,
  idempotencyKey: "idem-1",
  docId: "doc_1",
  commentId: "c1",
  threadId: "70",
  fromUid: "u_author",
  botUid: "bot_1",
  text: "fix it",
};

function ctxOf(msg: BotMessage): DocTaskContext {
  return msg.payload[DOC_TASK_PAYLOAD_KEY] as DocTaskContext;
}

beforeEach(() => {
  postDocReply.mockReset().mockResolvedValue(undefined);
  isPermanentDocCommentFailure.mockReset().mockReturnValue(false);
});

describe("createDocMentionHandler", () => {
  it("happy path: posts the final answer, marks dedupe complete, no fallback/dead-letter", async () => {
    const dedupe = createMemoryDocMentionDedupeStore();
    const deadLetter = createMemoryDocTaskDeadLetterStore();
    const dispatch: DocMentionDispatch = async (msg) => {
      const ctx = ctxOf(msg);
      await ctx.postComment("the answer", "final");
      ctx.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
    };
    const handle = createDocMentionHandler({
      botUid: "bot_1", apiUrl: "https://x", botToken: "t", dedupe, deadLetter, dispatch,
    });

    await handle(MENTION);

    expect(postDocReply).toHaveBeenCalledTimes(1);
    expect(postDocReply.mock.calls[0][0]).toMatchObject({ body: "the answer", intent: "final" });
    expect(await deadLetter.list()).toHaveLength(0);
    // A second delivery of the same comment is deduped (complete persisted).
    postDocReply.mockClear();
    await handle(MENTION);
    expect(postDocReply).not.toHaveBeenCalled();
  });

  it("drops an event addressed to another bot before claiming", async () => {
    const dedupe = createMemoryDocMentionDedupeStore();
    const dispatch = vi.fn<DocMentionDispatch>();
    const handle = createDocMentionHandler({
      botUid: "bot_1", apiUrl: "https://x", botToken: "t", dedupe, dispatch,
    });
    await handle({ ...MENTION, botUid: "someone_else" });
    expect(dispatch).not.toHaveBeenCalled();
    // key not claimed → a correctly-addressed re-delivery still runs
    expect(await dedupe.claim(docTaskDedupeKey(MENTION))).toBe(false);
  });

  it("user left hanging (no reply) → posts a notice, does NOT complete dedupe", async () => {
    const dedupe = createMemoryDocMentionDedupeStore();
    const deadLetter = createMemoryDocTaskDeadLetterStore();
    // dispatch produces nothing (agent emitted no text) → reportTurn never called.
    const dispatch: DocMentionDispatch = async () => {};
    const handle = createDocMentionHandler({
      botUid: "bot_1", apiUrl: "https://x", botToken: "t", dedupe, deadLetter, dispatch,
    });

    await handle(MENTION);

    expect(postDocReply).toHaveBeenCalledTimes(1);
    expect(postDocReply.mock.calls[0][0]).toMatchObject({ intent: "notice" });
    expect(await deadLetter.list()).toHaveLength(0);
    // Not completed → a re-delivery is allowed to try again.
    expect(await dedupe.claim(docTaskDedupeKey(MENTION))).toBe(false);
  });

  it("answer AND notice both fail → dead-letters with the (docId,threadId,commentId) triple + classification", async () => {
    const dedupe = createMemoryDocMentionDedupeStore();
    const deadLetter = createMemoryDocTaskDeadLetterStore();
    // Every post fails; classify the failure as permanent.
    postDocReply.mockRejectedValue(new Error("Octo API /p failed (400): bad"));
    isPermanentDocCommentFailure.mockReturnValue(true);
    const dispatch: DocMentionDispatch = async (msg) => {
      const ctx = ctxOf(msg);
      try {
        await ctx.postComment("the answer", "final");
        ctx.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
      } catch {
        ctx.reportTurn({ finalDelivered: false, delivered: false, lost: true, noticed: false });
      }
    };
    const handle = createDocMentionHandler({
      botUid: "bot_1", apiUrl: "https://x", botToken: "t", dedupe, deadLetter, dispatch,
    });

    await handle(MENTION);

    const entries = await deadLetter.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      docId: "doc_1",
      threadId: "70",
      commentId: "c1",
      reason: "permanent_failure",
      key: docTaskDedupeKey(MENTION),
    });
  });

  it("skips a duplicate: an already-claimed key is not dispatched", async () => {
    const dedupe = createMemoryDocMentionDedupeStore();
    await dedupe.claim(docTaskDedupeKey(MENTION)); // pre-claim (in flight)
    const dispatch = vi.fn<DocMentionDispatch>();
    const handle = createDocMentionHandler({
      botUid: "bot_1", apiUrl: "https://x", botToken: "t", dedupe, dispatch,
    });
    await handle(MENTION);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
