/**
 * D1 — dead-letter store. Focus: it records the (docId,threadId,commentId)
 * triple + reason, never throws, is bounded, and truncates long detail.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileDocTaskDeadLetterStore,
  createMemoryDocTaskDeadLetterStore,
  truncateDetail,
  type DocTaskDeadLetter,
} from "../doc-task-deadletter.js";

const entry = (over: Partial<DocTaskDeadLetter> = {}): DocTaskDeadLetter => ({
  key: "idem#doc:thr:c1",
  docId: "doc_1",
  threadId: "70",
  commentId: "c1",
  at: "2026-09-06T00:00:00.000Z",
  reason: "undelivered_after_ack",
  ...over,
});

describe("truncateDetail", () => {
  it("trims, drops empties, caps length", () => {
    expect(truncateDetail(undefined)).toBeUndefined();
    expect(truncateDetail("   ")).toBeUndefined();
    expect(truncateDetail("x")).toBe("x");
    expect(truncateDetail("a".repeat(600))?.endsWith("…")).toBe(true);
    expect(truncateDetail("a".repeat(600))?.length).toBe(501);
  });
});

describe("memory dead-letter store", () => {
  it("records the triple + reason and lists it", async () => {
    const s = createMemoryDocTaskDeadLetterStore();
    await s.record(entry({ reason: "permanent_failure", detail: "boom" }));
    const list = await s.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ docId: "doc_1", threadId: "70", commentId: "c1", reason: "permanent_failure" });
  });

  it("is bounded by capacity", async () => {
    const s = createMemoryDocTaskDeadLetterStore(2);
    await s.record(entry({ commentId: "c1" }));
    await s.record(entry({ commentId: "c2" }));
    await s.record(entry({ commentId: "c3" }));
    const list = await s.list();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.commentId)).toEqual(["c2", "c3"]);
  });
});

describe("file dead-letter store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "doc-dl-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists across instances", async () => {
    const s1 = createFileDocTaskDeadLetterStore({ baseDir: dir });
    await s1.record(entry());
    const s2 = createFileDocTaskDeadLetterStore({ baseDir: dir });
    expect(await s2.list()).toHaveLength(1);
  });

  it("never throws even if the record cannot be written (baseDir is a file)", async () => {
    // Point baseDir at a path whose parent makes mkdir/rename fail; record must swallow.
    const badDir = join(dir, "not", "a", "real", "\0invalid");
    const s = createFileDocTaskDeadLetterStore({ baseDir: badDir });
    await expect(s.record(entry())).resolves.toBeUndefined();
  });
});
