/**
 * A8: status-frame rendering — freeze submitted inputs, strip actions on terminal
 * states, keep them on recoverable errors, and neutralize untrusted echoes so a
 * submitted value / operator name cannot inject an active markdown link.
 */
import { describe, it, expect } from 'vitest';
import { renderCardActionStatus } from '../card-action-status.js';

function baseCard() {
  return {
    type: 'AdaptiveCard',
    body: [
      { type: 'Input.Text', id: 'note', label: 'Note' },
      { type: 'TextBlock', text: 'Approve?' },
    ],
    actions: [{ type: 'Action.Submit', id: 'yes', title: 'Yes' }],
  } as Record<string, unknown>;
}

function lastBodyText(card: Record<string, unknown>): string {
  const body = card.body as Array<Record<string, unknown>>;
  return String(body[body.length - 1].text ?? '');
}

describe('renderCardActionStatus', () => {
  it('completed: freezes inputs, appends a ✅ line, and strips Action.Submit', () => {
    const { card, plain } = renderCardActionStatus({
      card: baseCard(),
      plain: 'Approve?\n可选操作：Yes',
      inputs: { note: 'hello' },
      operator: 'Alice',
      actionLabel: 'Yes',
      status: 'completed',
    });
    expect(card.actions).toBeUndefined(); // terminal → not clickable
    const body = card.body as Array<Record<string, unknown>>;
    expect(body.some((b) => String(b.text ?? '').includes('Note：hello'))).toBe(true);
    expect(lastBodyText(card)).toMatch(/^✅/);
    expect(plain).not.toContain('可选操作：'); // action hint dropped from the frozen frame
  });

  it('preserveControls: keeps Action.Submit and appends a ⚠️ line so a resubmit is reachable', () => {
    const { card } = renderCardActionStatus({
      card: baseCard(),
      plain: 'Approve?',
      operator: 'Alice',
      actionLabel: 'Yes',
      status: 'error',
      errorText: '提交字段与原卡不匹配',
      preserveControls: true,
    });
    expect(card.actions).toBeDefined(); // recoverable → still clickable
    expect(lastBodyText(card)).toMatch(/^⚠️/);
  });

  it('neutralizes an untrusted operator name so no active markdown link forms', () => {
    const { card } = renderCardActionStatus({
      card: baseCard(),
      plain: 'Approve?',
      operator: '[click](http://evil.example.com)',
      actionLabel: 'Yes',
      status: 'processing',
    });
    const line = lastBodyText(card);
    // The link cannot form: its brackets are backslash-escaped, so `[click](…)` is inert.
    expect(line).toContain('\\[click\\]');
    expect(line).not.toContain('[click]');
  });

  it('freezes a ChoiceSet selection to its authored title, not the raw submitted value', () => {
    const card = {
      type: 'AdaptiveCard',
      body: [{ type: 'Input.ChoiceSet', id: 'pick', label: 'Pick', choices: [{ title: 'Blue', value: 'b' }] }],
      actions: [{ type: 'Action.Submit', id: 'go', title: 'Go' }],
    } as Record<string, unknown>;
    const { card: out } = renderCardActionStatus({
      card,
      plain: 'Pick',
      inputs: { pick: 'b' },
      operator: 'Alice',
      actionLabel: 'Go',
      status: 'completed',
    });
    const body = out.body as Array<Record<string, unknown>>;
    expect(body.some((b) => String(b.text ?? '').includes('Pick：Blue'))).toBe(true);
  });
});
