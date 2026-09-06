/**
 * D1 — persistent dedupe for doc-comment tasks (ported from openclaw
 * `doc-mention-dedupe.ts`).
 *
 * Why persistent: the event poller advances the cursor + acks AFTER executing
 * (a doc task mutates the document, so replay is not idempotent — see
 * card-events-poll), and octo-server re-delivers if it crashes after enqueue
 * before confirm. Both converge only if the consumer dedupes by key across
 * process restarts, so a memory-only set would be punched through by a restart.
 *
 * The dedupe KEY is comment-grained (`docTaskDedupeKey`, architect gate #3):
 * different comments under one thread never evict each other.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_CAPACITY = 500;

export interface DocMentionDedupeStore {
  /** Already completed (disk) or in-flight (this process) → true (skip);
   *  otherwise mark in-flight and return false. In-flight is memory-only on
   *  purpose: a crash mid-task must be replayable (the task never finished). */
  claim(key: string): Promise<boolean>;
  /** Success: persist to disk (cross-process dedupe from here on). */
  complete(key: string): Promise<void>;
  /** Not finished: drop the in-flight mark so a re-delivery can run again. */
  release(key: string): void;
}

interface DedupeFile {
  keys?: unknown;
}

export function createFileDocMentionDedupeStore(params: {
  /** Per-bot state dir (config.dataDir). The file lives directly under it. */
  baseDir: string;
  capacity?: number;
  log?: { error?: (message: string) => void };
}): DocMentionDedupeStore {
  const capacity = Math.max(1, Math.floor(params.capacity ?? DEFAULT_CAPACITY));
  const dir = params.baseDir;
  const file = join(dir, "doc-mentions.processed.json");

  let loaded: Promise<string[]> | undefined;
  let cache: string[] | undefined;
  const inFlight = new Set<string>();
  // Serialize writes (rename is atomic, read-modify-write is not). Single-process
  // assumption — cc runs one poller per bot process.
  let tail: Promise<void> = Promise.resolve();

  const load = async (): Promise<string[]> => {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as DedupeFile;
      return Array.isArray(raw.keys)
        ? raw.keys.filter((key): key is string => typeof key === "string").slice(-capacity)
        : [];
    } catch (err) {
      // Cold start (ENOENT) is normal → empty. Other errors also degrade to empty
      // but must log: silently dropping the table means every event replays, and
      // these tasks mutate documents.
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        params.log?.error?.(
          `octo: doc mention dedupe store unreadable at ${file}, starting empty (replays possible): ${String(err)}`,
        );
      }
      return [];
    }
  };

  const persist = async (keys: string[]): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.doc-mentions.${process.pid}.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      await writeFile(tmp, `${JSON.stringify({ keys })}\n`, "utf8");
      await rename(tmp, file);
      renamed = true;
    } finally {
      if (!renamed) await rm(tmp, { force: true }).catch(() => {});
    }
  };

  return {
    async claim(key: string): Promise<boolean> {
      if (!key) return false;
      const run = tail.then(async () => {
        loaded ??= load();
        cache ??= await loaded;
        if (cache.includes(key) || inFlight.has(key)) return true;
        inFlight.add(key);
        return false;
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },

    async complete(key: string): Promise<void> {
      if (!key) return;
      const run = tail.then(async () => {
        loaded ??= load();
        cache ??= await loaded;
        if (cache.includes(key)) { inFlight.delete(key); return; }
        // Persist first, update memory only on success: the reverse would mark
        // memory "done" while a persist error leaves the caller retrying, which
        // memory then rejects as duplicate → the task is silently lost.
        const next = [...cache, key];
        if (next.length > capacity) next.splice(0, next.length - capacity);
        try {
          await persist(next);
          cache = next;
        } finally {
          inFlight.delete(key);
        }
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },

    release(key: string): void {
      inFlight.delete(key);
    },
  };
}

/** In-process implementation (tests / persistence disabled). */
export function createMemoryDocMentionDedupeStore(capacity = DEFAULT_CAPACITY): DocMentionDedupeStore {
  const keys: string[] = [];
  const inFlight = new Set<string>();
  return {
    async claim(key: string): Promise<boolean> {
      if (!key) return false;
      if (keys.includes(key) || inFlight.has(key)) return true;
      inFlight.add(key);
      return false;
    },
    async complete(key: string): Promise<void> {
      if (!key) return;
      inFlight.delete(key);
      if (keys.includes(key)) return;
      keys.push(key);
      if (keys.length > capacity) keys.splice(0, keys.length - capacity);
    },
    release(key: string): void { inFlight.delete(key); },
  };
}
