/**
 * D1 core — event parsing, per-thread scope, comment-granular dedupe key,
 * non-routable sentinel channel, parent-id derivation, and message synthesis.
 */
import { describe, it, expect } from "vitest";
import {
  parseDocCommentMention,
  docTaskSessionScope,
  docTaskDedupeKey,
  docTaskSentinelChannelId,
  docCommentParentId,
  synthesizeDocMentionMessage,
  formatDocMentionText,
  type DocTaskContext,
} from "../doc-mention.js";
import { DOC_FIRE_NONCE, DOC_FIRE_NONCE_KEY, DOC_TASK_PAYLOAD_KEY } from "../doc-fire-marker.js";
import { isDocTaskNonRoutableTarget, isDocTaskSessionKey } from "../doc-task-scope.js";
import { ChannelType, type BotEvent } from "../octo/types.js";

function event(overrides: Record<string, unknown> = {}, top: Partial<BotEvent> = {}): BotEvent {
  return {
    event_id: 5,
    event_type: "doc_comment_mention",
    event_data: {
      idempotency_key: "idem-1",
      doc_id: "doc_1",
      comment_id: "c1",
      thread_id: "70",
      from_uid: "u_author",
      bot_uid: "bot_1",
      text: "please fix E8",
      ...overrides,
    },
    ...top,
  };
}

describe("parseDocCommentMention", () => {
  it("parses a well-formed event", () => {
    const m = parseDocCommentMention(event());
    expect(m).toMatchObject({
      idempotencyKey: "idem-1",
      docId: "doc_1",
      commentId: "c1",
      threadId: "70",
      fromUid: "u_author",
      botUid: "bot_1",
      text: "please fix E8",
    });
    expect(m?.docKind).toBeUndefined();
  });

  it("recognizes doc_kind=html and falls thread_id back to comment_id", () => {
    const m = parseDocCommentMention(event({ doc_kind: "HTML", thread_id: "" }));
    expect(m?.docKind).toBe("html");
    expect(m?.threadId).toBe("c1");
  });

  it("rejects wrong event_type / missing required fields / blank text", () => {
    expect(parseDocCommentMention(event({}, { event_type: "card_action" }))).toBeNull();
    expect(parseDocCommentMention(event({ doc_id: "" }))).toBeNull();
    expect(parseDocCommentMention(event({ bot_uid: "" }))).toBeNull();
    expect(parseDocCommentMention(event({ text: "   " }))).toBeNull();
  });
});

describe("scope + dedupe key", () => {
  const base = parseDocCommentMention(event())!;

  it("session scope is per (docId, threadId) and doctask-namespaced", () => {
    expect(docTaskSessionScope(base)).toBe("doctask:doc_1:70");
    expect(isDocTaskSessionKey(docTaskSessionScope(base))).toBe(true);
  });

  it("dedupe key is COMMENT-grained: different comments in one thread don't collide", () => {
    const c1 = parseDocCommentMention(event({ comment_id: "c1" }))!;
    const c2 = parseDocCommentMention(event({ comment_id: "c2" }))!;
    expect(docTaskDedupeKey(c1)).not.toBe(docTaskDedupeKey(c2));
    // Same comment re-delivered → identical key (idempotent hit).
    expect(docTaskDedupeKey(parseDocCommentMention(event({ comment_id: "c1" }))!)).toBe(docTaskDedupeKey(c1));
  });

  it("dedupe key escapes ':' so field boundaries can't be forged into a collision", () => {
    const a = parseDocCommentMention(event({ doc_id: "d:1", thread_id: "2", comment_id: "c" }))!;
    const b = parseDocCommentMention(event({ doc_id: "d", thread_id: "1:2", comment_id: "c" }))!;
    expect(docTaskDedupeKey(a)).not.toBe(docTaskDedupeKey(b));
  });

  it("sentinel channel id is non-routable AND recognized as a doc-task session", () => {
    const ch = docTaskSentinelChannelId(base);
    expect(isDocTaskNonRoutableTarget(ch)).toBe(true);
    expect(isDocTaskSessionKey(ch)).toBe(true);
  });
});

describe("docCommentParentId", () => {
  it("returns the decimal thread id, else undefined (root)", () => {
    expect(docCommentParentId(parseDocCommentMention(event({ thread_id: "70" }))!)).toBe("70");
    expect(docCommentParentId(parseDocCommentMention(event({ thread_id: "abc" }))!)).toBeUndefined();
    expect(docCommentParentId(parseDocCommentMention(event({ thread_id: "070" }))!)).toBeUndefined();
  });
});

describe("synthesizeDocMentionMessage", () => {
  const mention = parseDocCommentMention(event())!;
  const ctx: DocTaskContext = {
    docId: mention.docId,
    threadId: mention.threadId,
    commentId: mention.commentId,
    sessionScope: docTaskSessionScope(mention),
    postComment: async () => {},
    reportTurn: () => {},
  };

  it("is DM-shaped, on the sentinel channel, carrying _docTask + the authentic nonce", () => {
    const msg = synthesizeDocMentionMessage(mention, "bot_1", ctx, { now: 1000 });
    expect(msg.channel_type).toBe(ChannelType.DM);
    expect(msg.channel_id).toBe(docTaskSentinelChannelId(mention));
    expect(isDocTaskNonRoutableTarget(msg.channel_id)).toBe(true);
    expect(msg.payload[DOC_TASK_PAYLOAD_KEY]).toBe(ctx);
    expect(msg.payload[DOC_FIRE_NONCE_KEY]).toBe(DOC_FIRE_NONCE);
    expect(msg.payload.mention).toEqual({ uids: ["bot_1"] });
  });

  it("prompt embeds the user comment as a JSON value (injection posture)", () => {
    const text = formatDocMentionText(mention);
    expect(text).toContain('comment="please fix E8"');
    expect(text).toContain("[Octo doc comment task]");
  });

  it("only builds the whole-doc URL from the provided docsBaseUrl (never inferred)", () => {
    const withBase = formatDocMentionText({ ...mention, docKind: "html" }, { docsBaseUrl: "https://docs.example.com/" });
    expect(withBase).toContain("https://docs.example.com/docs-html/d/doc_1/v/latest/export?download=0");
    const noBase = formatDocMentionText({ ...mention, docKind: "html" });
    expect(noBase).not.toContain("http");
  });
});
