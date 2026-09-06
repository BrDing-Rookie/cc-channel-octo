/**
 * D1 — dead-letter record for doc-comment tasks (ported from openclaw
 * `doc-task-deadletter.ts`).
 *
 * There is an "acked but the user got nothing" window: the poller advances the
 * cursor + acks after executing (to avoid replaying a non-idempotent doc edit),
 * but "executed" ≠ "the user saw a reply" — the final POST can fail all retries
 * and the fallback notice can fail too (same doc backend, same outage). The
 * event is then acked; the server re-delivers nothing. So we persist a record —
 * NOT a replay queue (replaying a doc edit is not idempotent) — so an operator
 * can answer "what happened to that @Bot".
 *
 * The record carries the (docId, threadId, commentId) triple (architect gate #3)
 * + the failure classification, and `record()` NEVER throws (it sits on a
 * failure-cleanup path; throwing would jam the poller cursor).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_CAPACITY = 200;
const DETAIL_MAX = 500;

export interface DocTaskDeadLetter {
  /** Comment-grained dedupe key (cross-reference with the dedupe table). */
  key: string;
  docId: string;
  threadId: string;
  commentId: string;
  /** ISO timestamp. */
  at: string;
  /**
   * Why it dead-lettered. `undelivered_after_ack`: answer + fallback both failed.
   * `permanent_failure`: the doc backend rejected deterministically (4xx /
   * envelope) so retry could not help. Kept as a field for future classes.
   */
  reason: "undelivered_after_ack" | "permanent_failure";
  /** Last POST error summary (truncated). */
  detail?: string;
}

export interface DocTaskDeadLetterStore {
  /** Record one. **Never throws** — the call site is a failure-cleanup path. */
  record(entry: DocTaskDeadLetter): Promise<void>;
  /** Read all (ops / tests). */
  list(): Promise<DocTaskDeadLetter[]>;
}

interface DeadLetterFile {
  entries?: unknown;
}

/** detail truncation: an error string may carry a whole stack. */
export function truncateDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const trimmed = detail.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > DETAIL_MAX ? `${trimmed.slice(0, DETAIL_MAX)}…` : trimmed;
}

export function createFileDocTaskDeadLetterStore(params: {
  /** Per-bot state dir (config.dataDir). */
  baseDir: string;
  capacity?: number;
  log?: { error?: (message: string) => void };
}): DocTaskDeadLetterStore {
  const capacity = Math.max(1, Math.floor(params.capacity ?? DEFAULT_CAPACITY));
  const dir = params.baseDir;
  const file = join(dir, "doc-tasks.deadletter.json");

  // Serialize read-modify-write (rename atomic, read-modify-write not).
  let tail: Promise<void> = Promise.resolve();

  const read = async (): Promise<DocTaskDeadLetter[]> => {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as DeadLetterFile;
      if (!Array.isArray(raw.entries)) return [];
      return raw.entries
        .filter(
          (e): e is DocTaskDeadLetter =>
            !!e &&
            typeof e === "object" &&
            typeof (e as DocTaskDeadLetter).key === "string" &&
            typeof (e as DocTaskDeadLetter).at === "string",
        )
        .slice(-capacity);
    } catch {
      // Missing / corrupt file → empty. Dead-lettering is observability; it must
      // not affect the main flow because it cannot read itself.
      return [];
    }
  };

  return {
    async record(entry) {
      const run = tail.then(async () => {
        try {
          const entries = await read();
          entries.push({ ...entry, detail: truncateDetail(entry.detail) });
          await mkdir(dir, { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          await writeFile(tmp, JSON.stringify({ entries: entries.slice(-capacity) }), "utf8");
          await rename(tmp, file);
        } catch (err) {
          // Swallow + account. Throwing here escapes the poller's processing
          // segment, jams the cursor, and replays a non-idempotent doc edit —
          // trading a real re-run for an observability write is not acceptable.
          params.log?.error?.(
            `octo: doc task dead-letter write failed key=${entry.key} doc=${entry.docId}: ${String(err)}`,
          );
        }
      });
      tail = run;
      await run;
    },
    async list() {
      return read();
    },
  };
}

/** In-memory implementation (tests / no state dir). Bounded to avoid unbounded growth. */
export function createMemoryDocTaskDeadLetterStore(capacity = DEFAULT_CAPACITY): DocTaskDeadLetterStore {
  const cap = Math.max(1, Math.floor(capacity));
  const entries: DocTaskDeadLetter[] = [];
  return {
    async record(entry) {
      entries.push({ ...entry, detail: truncateDetail(entry.detail) });
      if (entries.length > cap) entries.splice(0, entries.length - cap);
    },
    async list() {
      return [...entries];
    },
  };
}
