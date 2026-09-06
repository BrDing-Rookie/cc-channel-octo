/**
 * G1 tests: `/fork` command handler (handleForkCommand) + the forked_sessions
 * store round-trip.
 *
 * These exercise all the pure/gating logic with injected fakes for createThread /
 * forkSdkSession / audit — no live server or SDK. The end-to-end fork→resume
 * (SDK session file lands in the parent cwd bucket and the child thread resumes
 * it) is NOT covered here: it needs a real model turn and is verified out of band.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleForkCommand, type ForkCommandDeps } from '../commands.js';
import { SessionStore } from '../session-store.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { deriveForkCwdCtx, resolveSessionCwd, type SessionCtx } from '../cwd-resolver.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PARENT_KEY = 'g100'; // a plain group channel_id
const OWNER = 'owner-uid';

/** Build ForkCommandDeps with sensible happy-path defaults + spy fakes. */
function makeDeps(over?: Partial<ForkCommandDeps>): ForkCommandDeps {
  return {
    args: '',
    parentSessionKey: PARENT_KEY,
    parentAnchorKey: PARENT_KEY,
    channelId: PARENT_KEY,
    isGroup: true,
    requesterUid: OWNER,
    ownerUid: OWNER,
    octoManagementEnabled: true,
    botToken: 'bf_token',
    parentCwd: '/tmp/base/deadbeef',
    store: {
      getSdkSessionId: vi.fn(() => 'parent-sdk-uuid'),
      setSdkSessionId: vi.fn(),
      setForkParent: vi.fn(),
    },
    createThread: vi.fn(async (_groupNo: string, name: string) => ({ shortId: 'T42', name })),
    forkSdkSession: vi.fn(async () => 'forked-sdk-uuid'),
    audit: vi.fn(),
    ...over,
  };
}

describe('handleForkCommand — gating', () => {
  it('refuses in a DM (no group to branch into)', async () => {
    const deps = makeDeps({ isGroup: false });
    const r = await handleForkCommand(deps);
    expect(r.handled).toBe(true);
    expect(r.reply).toMatch(/only works in a group or thread/i);
    expect(deps.createThread).not.toHaveBeenCalled();
  });

  it('is owner-only and audits the denial', async () => {
    const deps = makeDeps({ requesterUid: 'someone-else' });
    const r = await handleForkCommand(deps);
    expect(r.reply).toMatch(/limited to the bot owner/i);
    expect(deps.audit).toHaveBeenCalledWith('denied', 'owner-only');
    expect(deps.createThread).not.toHaveBeenCalled();
  });

  it('requires sdk.octoManagement', async () => {
    const deps = makeDeps({ octoManagementEnabled: false });
    const r = await handleForkCommand(deps);
    expect(r.reply).toMatch(/sdk\.octoManagement/);
    expect(deps.createThread).not.toHaveBeenCalled();
  });

  it('requires a User-Bot (bf_) token', async () => {
    const deps = makeDeps({ botToken: 'app_token' });
    const r = await handleForkCommand(deps);
    expect(r.reply).toMatch(/User-Bot \(bf_\) token/);
    expect(deps.createThread).not.toHaveBeenCalled();
  });

  it('refuses when there is no parent SDK session to fork', async () => {
    const deps = makeDeps({
      store: { getSdkSessionId: vi.fn(() => undefined), setSdkSessionId: vi.fn(), setForkParent: vi.fn() },
    });
    const r = await handleForkCommand(deps);
    expect(r.reply).toMatch(/nothing to fork yet/i);
    expect(deps.createThread).not.toHaveBeenCalled();
  });
});

describe('handleForkCommand — happy path', () => {
  it('creates a thread, forks the session, seeds the child + anchor, audits allowed', async () => {
    const deps = makeDeps({ args: 'design spike' });
    const r = await handleForkCommand(deps);

    expect(deps.createThread).toHaveBeenCalledWith('g100', 'design spike');
    expect(deps.forkSdkSession).toHaveBeenCalledWith('parent-sdk-uuid', '/tmp/base/deadbeef');
    // Child sessionKey = <groupNo>____<shortId>.
    expect(deps.store.setSdkSessionId).toHaveBeenCalledWith('g100____T42', 'forked-sdk-uuid');
    expect(deps.store.setForkParent).toHaveBeenCalledWith('g100____T42', 'g100');
    expect(deps.audit).toHaveBeenCalledWith('allowed');
    expect(r.reply).toMatch(/Forked this conversation into a new thread "design spike"/);
  });

  it('uses a default thread name for a bare /fork', async () => {
    const deps = makeDeps({ args: '' });
    await handleForkCommand(deps);
    expect(deps.createThread).toHaveBeenCalledWith('g100', 'Forked conversation');
  });

  it('forks off the PARENT group when invoked inside a thread', async () => {
    // channelId is a thread composite; the new thread must attach to the parent
    // group (g100), not nest under the thread.
    const deps = makeDeps({ channelId: 'g100____T7', parentSessionKey: 'g100____T7', parentAnchorKey: 'g100____T7' });
    await handleForkCommand(deps);
    expect(deps.createThread).toHaveBeenCalledWith('g100', 'Forked conversation');
    expect(deps.store.setForkParent).toHaveBeenCalledWith('g100____T42', 'g100____T7');
  });

  it('anchors a fork-of-a-fork to the ROOT bucket, not the immediate parent', async () => {
    // The parent thread is itself a fork whose cwd/session live in the ROOT
    // group's bucket, so the new child must anchor to that same root — otherwise
    // its cwd would not line up with where forkSdkSession wrote the transcript.
    const deps = makeDeps({
      channelId: 'g100____T7',
      parentSessionKey: 'g100____T7',
      parentAnchorKey: 'g100', // resolved by index.ts from getForkParent(parent)
    });
    await handleForkCommand(deps);
    expect(deps.store.setForkParent).toHaveBeenCalledWith('g100____T42', 'g100');
  });
});

describe('handleForkCommand — failure degradation', () => {
  it('reports a create-thread failure without seeding anything', async () => {
    const deps = makeDeps({ createThread: vi.fn(async () => null) });
    const r = await handleForkCommand(deps);
    expect(r.reply).toMatch(/could not create the thread/i);
    expect(deps.forkSdkSession).not.toHaveBeenCalled();
    expect(deps.store.setSdkSessionId).not.toHaveBeenCalled();
    expect(deps.store.setForkParent).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith('denied', 'create-thread failed');
  });

  it('reports a fork failure and does NOT seed the child (thread exists, starts fresh)', async () => {
    const deps = makeDeps({ forkSdkSession: vi.fn(async () => null) });
    const r = await handleForkCommand(deps);
    expect(r.reply).toMatch(/branching the conversation failed/i);
    expect(deps.store.setSdkSessionId).not.toHaveBeenCalled();
    expect(deps.store.setForkParent).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith('denied', 'fork-session failed');
  });
});

describe('SessionStore fork-parent anchor', () => {
  let adapter: DbAdapter;
  let store: SessionStore;

  beforeEach(() => {
    adapter = createAdapter(':memory:');
    store = new SessionStore(adapter);
    store.init();
  });
  afterEach(() => store.close());

  it('round-trips a fork-parent mapping and upserts (latest wins)', () => {
    expect(store.getForkParent('g1____child')).toBeUndefined();
    store.setForkParent('g1____child', 'g1');
    expect(store.getForkParent('g1____child')).toBe('g1');
    // Upsert to a new parent.
    store.setForkParent('g1____child', 'g2');
    expect(store.getForkParent('g1____child')).toBe('g2');
  });

  it('keeps the anchor independent of the SDK session id and history', () => {
    store.setForkParent('g1____child', 'g1');
    store.setSdkSessionId('g1____child', 'forked-uuid');
    expect(store.getSdkSessionId('g1____child')).toBe('forked-uuid');
    expect(store.getForkParent('g1____child')).toBe('g1');
  });
});

/**
 * Regression for the #16 blocker: index.ts must resolve the SDK-query cwd (the
 * bucket `resume` reads) via getForkParent → deriveForkCwdCtx, so a forked child
 * lands in its PARENT's bucket — not its own. The earlier bug anchored the media/
 * secret sandboxes but passed the child's own ctx to queryAgent, silently missing
 * the fork on the first turn. This exercises the exact selection path index.ts
 * uses at the queryAgent call site.
 */
describe('forked child SDK-query cwd resolves to the parent bucket', () => {
  let adapter: DbAdapter;
  let store: SessionStore;
  let base: string;

  beforeEach(() => {
    adapter = createAdapter(':memory:');
    store = new SessionStore(adapter);
    store.init();
    base = mkdtempSync(join(tmpdir(), 'fork-cwd-'));
  });
  afterEach(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('a session with setForkParent resolves its query cwd to the parent, not its own bucket', () => {
    const PARENT = 'g100';
    const CHILD = 'g100____T42';
    store.setForkParent(CHILD, PARENT);

    // What index.ts does at the queryAgent call site: ctx = own child ctx, then
    // fork-anchored via getForkParent.
    const childOwnCtx: SessionCtx = { kind: 'group', sessionKey: CHILD };
    const queryCtx = deriveForkCwdCtx(childOwnCtx, store.getForkParent(CHILD));

    const parentCwd = resolveSessionCwd(base, { kind: 'group', sessionKey: PARENT });
    const childOwnCwd = resolveSessionCwd(base, childOwnCtx);
    const queryCwd = resolveSessionCwd(base, queryCtx);

    // The forked child's SDK-query cwd MUST be the parent's bucket (where the
    // forked transcript lives), and MUST NOT be the child's own naive bucket.
    expect(queryCwd).toBe(parentCwd);
    expect(queryCwd).not.toBe(childOwnCwd);
  });

  it('a non-forked session resolves to its own bucket (unchanged behavior)', () => {
    const KEY = 'g200';
    const ownCtx: SessionCtx = { kind: 'group', sessionKey: KEY };
    const queryCtx = deriveForkCwdCtx(ownCtx, store.getForkParent(KEY)); // undefined anchor
    expect(resolveSessionCwd(base, queryCtx)).toBe(resolveSessionCwd(base, ownCtx));
  });
});

