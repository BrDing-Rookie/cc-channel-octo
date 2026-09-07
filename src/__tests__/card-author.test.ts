/**
 * A4: interactive card builder (buildInteractiveCard) — structural validation,
 * secret-shape rejection / redaction, and server-caps degradation. Exercises the
 * real card-render desensitize helpers (nothing mocked).
 */
import { describe, it, expect } from 'vitest';
import { buildInteractiveCard, type InteractiveCardSpec } from '../card-author.js';
import type { CardCaps } from '../card-render.js';

const SECRET = 'AKIAIOSFODNN7EXAMPLE'; // AWS key id — isSensitive(_, true) catches it

function baseSpec(over: Partial<InteractiveCardSpec> = {}): InteractiveCardSpec {
  return {
    title: 'Approve deploy?',
    buttons: [{ id: 'yes', label: 'Approve' }, { id: 'no', label: 'Reject' }],
    ...over,
  };
}

describe('card-author.buildInteractiveCard', () => {
  it('builds a valid interactive card with Action.Submit buttons + labels/ids', () => {
    const r = buildInteractiveCard(baseSpec());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.type).toBe('AdaptiveCard');
    const actions = r.card.actions as Array<Record<string, unknown>>;
    expect(actions.map((a) => a.type)).toEqual(['Action.Submit', 'Action.Submit']);
    expect(r.actionLabels).toEqual({ yes: 'Approve', no: 'Reject' });
    expect(r.plain).toContain('可选操作：');
  });

  it('requires at least one button', () => {
    const r = buildInteractiveCard(baseSpec({ buttons: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/at least one button/);
  });

  it('rejects a title carrying a secret shape', () => {
    const r = buildInteractiveCard(baseSpec({ title: `Deploy ${SECRET}` }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/sensitive/);
  });

  it('rejects a duplicate button id and an unsafe id', () => {
    expect(buildInteractiveCard(baseSpec({ buttons: [{ id: 'x', label: 'A' }, { id: 'x', label: 'B' }] })).ok).toBe(false);
    expect(buildInteractiveCard(baseSpec({ buttons: [{ id: 'bad id!', label: 'A' }] })).ok).toBe(false);
  });

  it('deep-redacts secret keys and secret values in button data', () => {
    const r = buildInteractiveCard(baseSpec({ buttons: [{ id: 'go', label: 'Go', data: { token: 'abc', note: SECRET } }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const action = (r.card.actions as Array<Record<string, unknown>>)[0];
    const data = action.data as Record<string, unknown>;
    expect(data.token).toBe('[redacted]'); // secret KEY name
    expect(data.note).toBe('[redacted]');  // secret VALUE shape
  });

  it('renders an options block as an expanded Input.ChoiceSet and tracks its input id', () => {
    const r = buildInteractiveCard(baseSpec({
      blocks: [{ type: 'options', id: 'pick', label: 'Pick one', options: [{ title: 'A', value: 'a' }, { title: 'B', value: 'b' }] }],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inputIds).toContain('pick');
    const body = r.card.body as Array<Record<string, unknown>>;
    expect(body.some((b) => b.type === 'Input.ChoiceSet' && b.id === 'pick' && b.style === 'expanded')).toBe(true);
  });

  it('fails Action.Submit when caps do not advertise octo/v2', () => {
    const caps: CardCaps = { elements: new Set(['TextBlock']), inputs: new Set(), actions: new Set() };
    const r = buildInteractiveCard(baseSpec(), caps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Action\.Submit is not supported/);
  });

  it('enforces the max button count', () => {
    const buttons = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, label: `B${i}` }));
    const r = buildInteractiveCard(baseSpec({ buttons }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/too many buttons/);
  });

  it('gives the interactive card the shared visual hierarchy: title Large, section title Medium', () => {
    const r = buildInteractiveCard(baseSpec({
      blocks: [{ type: 'section', title: 'Details', text: 'Deploy v1.2.3 to prod' }],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.card.body as Array<Record<string, unknown>>;
    // Masthead: bold + Large (same as display card title) — the card name is the biggest line.
    expect(body[0]).toMatchObject({ type: 'TextBlock', text: 'Approve deploy?', weight: 'Bolder', size: 'Large' });
    // Section title steps down to Medium (between the masthead and body text). It may be nested
    // inside a Container, so walk the tree.
    const flat: Record<string, unknown>[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === 'object') {
        flat.push(n as Record<string, unknown>);
        Object.values(n as Record<string, unknown>).forEach(walk);
      }
    };
    walk(body);
    expect(flat.some((n) => n.text === 'Details' && n.weight === 'Bolder' && n.size === 'Medium')).toBe(true);
  });
});
