/**
 * E1 persona-prompt tests: hint composition (grant variants), the fetch/cache
 * lifecycle, and the 代次守卫 (generation guard) that stops an in-flight refresh
 * from resurrecting a cleared cache after stop/reconfigure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const api = vi.hoisted(() => ({ getBotOboGrant: vi.fn() }));
vi.mock('../octo/api.js', () => api);

import {
  composePersonaHint,
  refreshPersonaPromptCache,
  initPersonaPromptCache,
  stopPersonaPromptCache,
  getPersonaPromptForSession,
  _resetPersonaPromptCacheForTests,
} from '../persona-prompt.js';
import type { BotOboGrant } from '../octo/api.js';

const silent = { info: () => {}, warn: () => {} };

beforeEach(() => {
  api.getBotOboGrant.mockReset();
  _resetPersonaPromptCacheForTests();
});
afterEach(() => {
  _resetPersonaPromptCacheForTests();
});

describe('composePersonaHint', () => {
  const full: BotOboGrant = { has_grant: true, grantor_uid: 'g', grantor_name: 'Ada', persona_prompt: 'Be concise.', active: true };

  it('composes a hint from an active grant with a persona_prompt', () => {
    const h = composePersonaHint(full);
    expect(h).toContain('Ada');
    expect(h).toContain('Be concise.');
  });

  it('falls back to grantor_uid when grantor_name is empty', () => {
    const h = composePersonaHint({ ...full, grantor_name: '  ' });
    expect(h).toContain('g');
  });

  it('returns undefined when no grant / paused / empty prompt', () => {
    expect(composePersonaHint({ has_grant: false })).toBeUndefined();
    expect(composePersonaHint({ ...full, active: false })).toBeUndefined();
    expect(composePersonaHint({ ...full, persona_prompt: '   ' })).toBeUndefined();
    expect(composePersonaHint({ has_grant: true, persona_prompt: 'x', active: true })).toBeUndefined(); // no grantor name/uid
  });
});

describe('refresh + cache', () => {
  it('a no-op for a bot without onBehalfOf (never fetches, no hint)', async () => {
    await refreshPersonaPromptCache({ botId: 'b1', apiUrl: 'u', botToken: 't' }, silent);
    expect(api.getBotOboGrant).not.toHaveBeenCalled();
    expect(getPersonaPromptForSession('b1')).toBeUndefined();
  });

  it('fetches + caches the composed hint for a persona clone', async () => {
    api.getBotOboGrant.mockResolvedValue({ has_grant: true, grantor_name: 'Ada', persona_prompt: 'P', active: true });
    await refreshPersonaPromptCache({ botId: 'b1', apiUrl: 'u', botToken: 't', onBehalfOf: 'g' }, silent);
    expect(getPersonaPromptForSession('b1')).toContain('Ada');
  });

  it('caches undefined when the grant is inactive (no stale hint served)', async () => {
    api.getBotOboGrant.mockResolvedValue({ has_grant: true, grantor_name: 'Ada', persona_prompt: 'P', active: false });
    await refreshPersonaPromptCache({ botId: 'b1', apiUrl: 'u', botToken: 't', onBehalfOf: 'g' }, silent);
    expect(getPersonaPromptForSession('b1')).toBeUndefined();
  });

  it('a fetch failure never throws and leaves no hint', async () => {
    api.getBotOboGrant.mockRejectedValue(new Error('boom'));
    await expect(refreshPersonaPromptCache({ botId: 'b1', apiUrl: 'u', botToken: 't', onBehalfOf: 'g' }, silent)).resolves.toBeUndefined();
    expect(getPersonaPromptForSession('b1')).toBeUndefined();
  });
});

describe('代次守卫 (generation guard)', () => {
  it('an in-flight refresh that resolves AFTER stop does not resurrect the cache', async () => {
    let resolveGrant!: (g: BotOboGrant) => void;
    api.getBotOboGrant.mockReturnValue(new Promise<BotOboGrant>((r) => { resolveGrant = r; }));

    // Start a refresh but do not await — the fetch is in flight.
    const p = refreshPersonaPromptCache({ botId: 'b1', apiUrl: 'u', botToken: 't', onBehalfOf: 'g' }, silent);
    // Stop the bot (bumps the generation) while the fetch is outstanding.
    stopPersonaPromptCache('b1');
    // Now let the stale fetch resolve.
    resolveGrant({ has_grant: true, grantor_name: 'Ada', persona_prompt: 'P', active: true });
    await p;

    // The superseded fetch must NOT have written into the cache.
    expect(getPersonaPromptForSession('b1')).toBeUndefined();
  });
});

describe('init / stop lifecycle', () => {
  it('init for a non-persona bot is a no-op (and tears down any prior state)', async () => {
    api.getBotOboGrant.mockResolvedValue({ has_grant: true, grantor_name: 'Ada', persona_prompt: 'P', active: true });
    // Seed a hint via a persona init, then reconfigure to a plain bot.
    initPersonaPromptCache({ botId: 'b1', apiUrl: 'u', botToken: 't', onBehalfOf: 'g' }, silent);
    await Promise.resolve(); await Promise.resolve();
    initPersonaPromptCache({ botId: 'b1', apiUrl: 'u', botToken: 't' }, silent); // onBehalfOf cleared
    expect(getPersonaPromptForSession('b1')).toBeUndefined();
    stopPersonaPromptCache('b1');
  });

  it('init clears the cache eagerly so the reader fails safe during the refetch window', async () => {
    // First: an active grant is cached.
    api.getBotOboGrant.mockResolvedValue({ has_grant: true, grantor_name: 'Ada', persona_prompt: 'P', active: true });
    await refreshPersonaPromptCache({ botId: 'b1', apiUrl: 'u', botToken: 't', onBehalfOf: 'g' }, silent);
    expect(getPersonaPromptForSession('b1')).toContain('Ada');
    // Re-init (reconfigure): the cache is cleared synchronously before the async refetch.
    api.getBotOboGrant.mockReturnValue(new Promise(() => {})); // never resolves
    initPersonaPromptCache({ botId: 'b1', apiUrl: 'u', botToken: 't', onBehalfOf: 'g2' }, silent);
    expect(getPersonaPromptForSession('b1')).toBeUndefined();
    stopPersonaPromptCache('b1');
  });
});
