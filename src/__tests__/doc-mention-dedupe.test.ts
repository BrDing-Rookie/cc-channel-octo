/**
 * D1 — persistent dedupe store. Focus: in-flight vs completed semantics, that
 * completion survives a new store instance (cross-process), and that release
 * re-allows a redelivery.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileDocMentionDedupeStore,
  createMemoryDocMentionDedupeStore,
} from "../doc-mention-dedupe.js";

describe("memory dedupe store", () => {
  it("claim marks in-flight; complete persists; release re-allows", async () => {
    const s = createMemoryDocMentionDedupeStore();
    expect(await s.claim("k1")).toBe(false); // first claim
    expect(await s.claim("k1")).toBe(true); // in-flight
    await s.complete("k1");
    expect(await s.claim("k1")).toBe(true); // completed

    expect(await s.claim("k2")).toBe(false);
    s.release("k2");
    expect(await s.claim("k2")).toBe(false); // released → claimable again
  });

  it("distinct (comment-grained) keys don't collide", async () => {
    const s = createMemoryDocMentionDedupeStore();
    expect(await s.claim("doc:thread:c1")).toBe(false);
    expect(await s.claim("doc:thread:c2")).toBe(false);
  });
});

describe("file dedupe store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "doc-dedupe-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("completed keys survive a fresh store instance (cross-process dedupe)", async () => {
    const s1 = createFileDocMentionDedupeStore({ baseDir: dir });
    expect(await s1.claim("k1")).toBe(false);
    await s1.complete("k1");

    const s2 = createFileDocMentionDedupeStore({ baseDir: dir });
    expect(await s2.claim("k1")).toBe(true); // loaded from disk
  });

  it("in-flight is NOT persisted: a crash mid-task (claim without complete) replays", async () => {
    const s1 = createFileDocMentionDedupeStore({ baseDir: dir });
    expect(await s1.claim("k1")).toBe(false); // claimed, never completed (crash)

    const s2 = createFileDocMentionDedupeStore({ baseDir: dir });
    expect(await s2.claim("k1")).toBe(false); // fresh process → replayable
  });
});
