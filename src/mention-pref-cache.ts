/**
 * Mention-preference server cache (F1) — IN-MEMORY ONLY, with a TTL.
 *
 * Holds the server-authoritative per-group mention preference ({@link MentionPref},
 * fetched over `GET /v1/bot/groups/{groupNo}/mention_pref`) keyed by parent
 * groupNo, in a process-local Map. This is the authoritative replacement for the
 * static `config.mentionFreeGroups` list: the mention gate reads `pref.effective`
 * to decide whether a mention-free message from a HUMAN sender may trigger a
 * reply (see session-router.ts). The static list remains only as a legacy local
 * operator override.
 *
 * Unlike the GROUP.md cache, the cached value here is a small boolean-triple, not
 * trusted prompt content — a stale/forged value can only widen or narrow the
 * @-mention gate for humans, never inject instructions. Even so it is cached
 * memory-only (no disk) for the same reason the md caches are: an on-disk artifact
 * the gateway user can write would be a poisoning vector, and cross-restart
 * durability buys nothing (a cold start simply re-fetches).
 *
 * Freshness: an entry expires `ttlMs` after it was stored; an expired read is a
 * miss (the gate re-fetches). This is a staleness BACKSTOP so an owner's
 * server-side preference edit eventually takes effect; event-driven invalidation
 * on `mention_pref_updated` (see group-md-events.ts / session-router.ts) sits on
 * top and the two do not conflict.
 *
 * The cache is a pure store (never fetches). The gate fetches on a miss via
 * `getMentionPref` — which itself never throws and fails closed — and calls
 * `set`, mirroring how the GROUP.md resolver drives {@link GroupMdCache}.
 *
 * Never throws.
 */

import type { MentionPref } from './octo/api.js';

/**
 * Default staleness backstop for a cached mention pref. Shorter than the GROUP.md
 * TTL: the pref gates every inbound group message, so a snappier re-fetch keeps an
 * owner's toggle responsive even before the `mention_pref_updated` event lands.
 */
export const DEFAULT_MENTION_PREF_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Only allow groupNos that are safe as a single Map key / log token. Mirrors
 * group-md-cache.ts / group-config.ts isSafeId — cheap defense-in-depth against a
 * crafted id even though nothing here touches the filesystem.
 */
function isSafeGroupNo(groupNo: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(groupNo) && groupNo !== '.' && groupNo !== '..';
}

interface StoredEntry {
  pref: MentionPref;
  storedAt: number;
}

export class MentionPrefCache {
  private readonly mem = new Map<string, StoredEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  /**
   * @param ttlMs staleness backstop in ms (entry expires this long after it was
   *   stored). Defaults to {@link DEFAULT_MENTION_PREF_TTL_MS}. A non-positive
   *   value disables expiry (entries live until invalidate()).
   * @param now injectable clock (testing); defaults to Date.now.
   */
  constructor(ttlMs: number = DEFAULT_MENTION_PREF_TTL_MS, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /**
   * Read a cached pref from memory. Returns undefined on a miss, an expired entry
   * (which is also evicted), or an unsafe groupNo.
   */
  get(groupNo: string): MentionPref | undefined {
    if (!isSafeGroupNo(groupNo)) return undefined;
    const stored = this.mem.get(groupNo);
    if (!stored) return undefined;
    if (this.ttlMs > 0 && this.now() - stored.storedAt >= this.ttlMs) {
      this.mem.delete(groupNo);
      return undefined;
    }
    return stored.pref;
  }

  /** Store a pref in memory, stamping it for TTL expiry. */
  set(groupNo: string, pref: MentionPref): void {
    if (!isSafeGroupNo(groupNo)) return;
    this.mem.set(groupNo, { pref, storedAt: this.now() });
  }

  /**
   * Drop a cached pref. The hook the event-driven refresh calls when the server
   * reports a `mention_pref_updated`, so the next turn re-fetches the
   * authoritative copy.
   */
  invalidate(groupNo: string): void {
    if (!isSafeGroupNo(groupNo)) return;
    this.mem.delete(groupNo);
  }
}
