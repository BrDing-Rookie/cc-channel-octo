import { describe, it, expect } from 'vitest';
import { MentionPrefCache, DEFAULT_MENTION_PREF_TTL_MS } from '../mention-pref-cache.js';
import type { MentionPref } from '../octo/api.js';

const PREF: MentionPref = { no_mention: true, group_allow_no_mention: true, effective: true };
const PREF2: MentionPref = { no_mention: false, group_allow_no_mention: true, effective: false };

describe('MentionPrefCache', () => {
  it('stores and returns a pref by groupNo', () => {
    const c = new MentionPrefCache();
    c.set('g1', PREF);
    expect(c.get('g1')).toEqual(PREF);
  });

  it('returns undefined on a miss', () => {
    const c = new MentionPrefCache();
    expect(c.get('nope')).toBeUndefined();
  });

  it('keys are independent per group', () => {
    const c = new MentionPrefCache();
    c.set('g1', PREF);
    c.set('g2', PREF2);
    expect(c.get('g1')).toEqual(PREF);
    expect(c.get('g2')).toEqual(PREF2);
  });

  it('expires an entry after the TTL (expired read is a miss and evicts)', () => {
    let now = 1_000;
    const c = new MentionPrefCache(100, () => now);
    c.set('g1', PREF);
    now = 1_099; // < ttl
    expect(c.get('g1')).toEqual(PREF);
    now = 1_100; // == ttl → expired
    expect(c.get('g1')).toBeUndefined();
    // second read confirms it was evicted, not merely masked
    now = 1_101;
    expect(c.get('g1')).toBeUndefined();
  });

  it('a non-positive TTL disables expiry (lives until invalidate)', () => {
    let now = 0;
    const c = new MentionPrefCache(0, () => now);
    c.set('g1', PREF);
    now = 10 ** 9;
    expect(c.get('g1')).toEqual(PREF);
    c.invalidate('g1');
    expect(c.get('g1')).toBeUndefined();
  });

  it('invalidate drops the entry (event-driven refresh hook)', () => {
    const c = new MentionPrefCache();
    c.set('g1', PREF);
    c.invalidate('g1');
    expect(c.get('g1')).toBeUndefined();
  });

  it('invalidate is total for a missing / unsafe id (never throws)', () => {
    const c = new MentionPrefCache();
    expect(() => c.invalidate('never-set')).not.toThrow();
    expect(() => c.invalidate('../etc')).not.toThrow();
  });

  it('rejects unsafe groupNos on set and get (defense-in-depth)', () => {
    const c = new MentionPrefCache();
    for (const bad of ['../etc', 'a/b', 'a b', '.', '..', '', 'g::x']) {
      c.set(bad, PREF);
      expect(c.get(bad)).toBeUndefined();
    }
  });

  it('exposes a sensible default TTL', () => {
    expect(DEFAULT_MENTION_PREF_TTL_MS).toBe(60 * 1000);
  });
});
