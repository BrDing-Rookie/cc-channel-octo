/**
 * A4: interactive-card tool — an in-process MCP server letting the agent post an
 * INTERACTIVE Adaptive Card (Action.Submit buttons + optional inputs) to the
 * CURRENT session's channel for confirmations, approvals, small menus, or short
 * forms. The tool surfaces to the model as `mcp__send_card__octo_send_card`.
 *
 * Built PER TURN (`createInteractiveCardToolServer`) with the current message's
 * channel coords + session key, so a sent card always lands in the session that
 * asked for it and its click (delivered later as a `card_action` event, A8) is
 * bound back to that session. Same two server-side invariants as the A9 display
 * card:
 *   1. Target is runtime-owned — the delivery channel comes from the per-turn
 *      coords, never tool arguments; a prompt-injected agent cannot retarget it.
 *   2. Identity is always the bot — no OBO / persona is ever derived from model
 *      input (type-17 + OBO is rejected server-side anyway).
 *
 * Fail-closed gateway: the D12 card profile is consulted before every send.
 * Interactive cards require the server to explicitly advertise them
 * (`config.interaction_enabled === true`) AND the `octo/v2` profile with a
 * compatible `card_version`. When interaction is unsupported but a card was still
 * requested, the same choices are delivered as PLAIN TEXT (graceful degrade),
 * never a hard failure — but a disabled Bot policy is a hard error (send plain
 * text yourself). On a real interactive send the card session is registered
 * (`card-session.ts`) so the A8 handler can look it up when the click arrives.
 *
 * Content safety rides on the A4 pure builder (`card-author.ts` →
 * `buildInteractiveCard`): every author-supplied string is URL-reduced +
 * secret-shape checked, button `data` is deep-sanitized, and the built card is
 * re-validated against the negotiated server caps. The agent never redacts itself.
 */

import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelType, CardProfile } from './octo/types.js';
import { CARD_INTERACTIVE_PROFILE, CARD_VERSION } from './octo/types.js';
import type { CardCaps } from './card-render.js';
import {
  buildInteractiveCard,
  type CardButtonSpec,
  type CardInputSpec,
  type InteractiveCardBlockSpec,
  type InteractiveCardSpec,
} from './card-author.js';
import { registerCardSession } from './card-session.js';
import { docTaskImEgressBlockReason } from './doc-task-scope.js';
import {
  deriveInteractiveCardCaps,
  generateClientMsgNo,
  getCardProfile,
  sendCardMessage,
  sendMessage,
  type CardProfileManifest,
} from './octo/api.js';

/** MCP server name; the tool surfaces as `mcp__send_card__octo_send_card`. */
export const INTERACTIVE_CARD_TOOL_SERVER_NAME = 'send_card';
/** Tool name inside the server (matches the openclaw parity name). */
export const INTERACTIVE_CARD_TOOL_NAME = 'octo_send_card';

/** Interactive-card send timeout — the wire POST has no default, so bound it here. */
const SEND_TIMEOUT_MS = 15_000;

/** Raw coords of the session invoking the tool — what a sent card is delivered to. */
export interface InteractiveCardSessionCoords {
  channelId: string;
  channelType: ChannelType;
}

/** Bot wire credentials + identity for this turn's account. */
export interface InteractiveCardToolConfig {
  apiUrl: string;
  botToken: string;
  /** Owning bot id — stored on the card session for the A8 identity check + poll starter. */
  accountId: string;
}

function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function errResult(msg: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

/**
 * Fail-closed gate for interactive sends. Returns null when interactive cards are
 * fully supported; otherwise a reason string. `Action.Submit` support is signalled
 * by the `octo/v2` profile, not the `actions` list (see api.ts deriveInteractiveCardCaps).
 * A `config.interaction_enabled !== true` policy is checked by the caller as a HARD
 * error; the other reasons trigger a plain-text degrade.
 */
export function interactiveCardGateReason(m: CardProfileManifest): string | null {
  if (!m.available || m.config?.interaction_enabled !== true) {
    return 'interactive cards are disabled by the server Bot policy';
  }
  if (!m.profiles?.includes(CARD_INTERACTIVE_PROFILE)) return 'octo/v2 is not advertised';
  if (typeof m.card_version === 'string' && m.card_version !== CARD_VERSION) {
    return `card_version ${m.card_version} is unsupported (need ${CARD_VERSION})`;
  }
  return null;
}

function normalizeButtons(value: unknown): CardButtonSpec[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const raw = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    return {
      id: typeof raw.id === 'string' ? raw.id : '',
      label: typeof raw.label === 'string' ? raw.label : '',
      ...(raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
        ? { data: raw.data as Record<string, unknown> }
        : {}),
      ...(raw.style === 'positive' || raw.style === 'destructive' ? { style: raw.style } : {}),
    };
  });
}

function normalizeInputs(value: unknown): CardInputSpec[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const raw = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const choices = Array.isArray(raw.choices)
      ? raw.choices.flatMap((choice) => {
          if (!choice || typeof choice !== 'object') return [];
          const candidate = choice as Record<string, unknown>;
          return typeof candidate.title === 'string' && typeof candidate.value === 'string'
            ? [{ title: candidate.title, value: candidate.value }]
            : [];
        })
      : undefined;
    return {
      id: typeof raw.id === 'string' ? raw.id : '',
      ...(typeof raw.kind === 'string' ? { kind: raw.kind as CardInputSpec['kind'] } : {}),
      ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
      ...(typeof raw.placeholder === 'string' ? { placeholder: raw.placeholder } : {}),
      ...(choices ? { choices } : {}),
    };
  });
}

function normalizeBlocks(value: unknown): InteractiveCardBlockSpec[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const raw = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    if (raw.type === 'section') {
      const facts = Array.isArray(raw.facts)
        ? raw.facts.map((fact) => {
            const candidate = fact && typeof fact === 'object' ? (fact as Record<string, unknown>) : {};
            return {
              title: typeof candidate.title === 'string' ? candidate.title : '',
              value: typeof candidate.value === 'string' ? candidate.value : '',
            };
          })
        : undefined;
      return {
        type: 'section',
        ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
        ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
        ...(facts ? { facts } : {}),
      };
    }
    if (raw.type === 'options') {
      const options = Array.isArray(raw.options)
        ? raw.options.map((option) => {
            const candidate = option && typeof option === 'object' ? (option as Record<string, unknown>) : {};
            return {
              title: typeof candidate.title === 'string' ? candidate.title : '',
              value: typeof candidate.value === 'string' ? candidate.value : '',
            };
          })
        : [];
      return {
        type: 'options',
        id: typeof raw.id === 'string' ? raw.id : '',
        ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
        options,
      };
    }
    return { type: String(raw.type ?? '') } as never;
  });
}

const TOOL_DESCRIPTION =
  'Send an INTERACTIVE Adaptive Card (Action.Submit buttons, optional inputs) to the CURRENT ' +
  'Octo conversation for confirmations, approvals, small menus, or short forms. The target ' +
  'channel comes from the trusted runtime session and CANNOT be selected by tool arguments; the ' +
  'card is always posted as the bot itself. Each button click returns to you LATER as a new ' +
  'message in this same conversation (the card shows a status frame while it is processed), so ' +
  'use this only when you actually want to pause for a user decision. For structured choices, ' +
  'use controlled `blocks`: one `section` per option and an `options` block for the ChoiceSet, ' +
  'and keep button labels short. Unsupported deployments automatically receive the same choices ' +
  'as PLAIN TEXT — you never need to check compatibility yourself. Content is fully visible to ' +
  'all group members: NEVER put secrets or tokens in any field, and NEVER treat a click as proof ' +
  'of business authorization. IMPORTANT — this tool is a side-effect that posts a card; it is ' +
  'NOT your conversational reply. After it returns you MUST still emit a short final text message.';

/**
 * Build the interactive-card tool DEFINITIONS for one agent turn. Exported
 * separately from the server so tests can invoke the handler directly.
 */
export function buildInteractiveCardTools(
  config: InteractiveCardToolConfig,
  coords: InteractiveCardSessionCoords,
  sessionKey?: string,
) {
  return [
    tool(
      INTERACTIVE_CARD_TOOL_NAME,
      TOOL_DESCRIPTION,
      {
        title: z.string().describe('Card title, rendered bold at the top. Required.'),
        text: z.string().optional().describe('Optional lead paragraph under the title.'),
        blocks: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            'Optional controlled body blocks. Each is one of: ' +
              "{type:'section', title?, text?, facts?:[{title,value}]} · " +
              "{type:'options', id, label?, options:[{title,value}]} (renders an expanded Input.ChoiceSet).",
          ),
        buttons: z
          .array(z.record(z.string(), z.unknown()))
          .describe(
            'Submit buttons (1-6). Each: {id, label, data?:object, style?:\'positive\'|\'destructive\'}. ' +
              'The clicked button id + any inputs come back to you as a card_action.',
          ),
        inputs: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            'Optional inputs (max 5). Each: {id, kind?:\'text\'|\'number\'|\'date\'|\'time\'|\'toggle\'|\'choice\', ' +
              'label?, placeholder?, choices?:[{title,value}]}.',
          ),
      },
      async (args) => {
        try {
          if (!config.botToken || !config.apiUrl) {
            return errResult('Octo account is not fully configured');
          }
          if (!coords.channelId || !coords.channelId.trim()) {
            return errResult('the current Octo delivery channel is unavailable');
          }
          // D3 egress fail-closed: a doc-task session binds to a non-routable
          // sentinel channel, so a card would post into IM (or a bogus channel).
          const docTaskBlock = docTaskImEgressBlockReason(coords.channelId, INTERACTIVE_CARD_TOOL_NAME);
          if (docTaskBlock) return errResult(docTaskBlock);
          const spec: InteractiveCardSpec = {
            title: typeof args.title === 'string' ? args.title : '',
            ...(typeof args.text === 'string' ? { text: args.text } : {}),
            ...(args.blocks !== undefined ? { blocks: normalizeBlocks(args.blocks) } : {}),
            buttons: normalizeButtons(args.buttons),
            ...(args.inputs !== undefined ? { inputs: normalizeInputs(args.inputs) } : {}),
          };
          // Baseline build (no caps) validates author content up front and gives the
          // plain-text degrade its body even when the profile probe fails.
          const baseline = buildInteractiveCard(spec);
          if (!baseline.ok) return errResult(baseline.error);

          // D12 capability probe. getCardProfile is fail-closed: a 404 yields
          // { available:false }, a malformed body yields disabled, transport / 5xx throws.
          let manifest: CardProfileManifest;
          try {
            manifest = await getCardProfile({
              apiUrl: config.apiUrl,
              botToken: config.botToken,
              signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });
          } catch (e) {
            return errResult(`card profile probe failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          // A disabled Bot policy is a HARD error — do not silently spam plain text when the
          // operator turned interaction off. Any other gap (old server, no octo/v2) degrades.
          if (!manifest.available || manifest.config?.interaction_enabled !== true) {
            return errResult(
              'interactive cards are disabled by the server Bot policy. Send your reply as plain text instead.',
            );
          }
          let unsupportedReason = interactiveCardGateReason(manifest) ?? '';

          let built = baseline;
          let negotiatedCaps: CardCaps | undefined;
          if (!unsupportedReason) {
            negotiatedCaps = deriveInteractiveCardCaps(manifest);
            const strict = buildInteractiveCard(spec, negotiatedCaps);
            if (strict.ok) built = strict;
            else unsupportedReason = strict.error;
          }

          // Graceful degrade: interaction not available on this deployment → deliver the same
          // choices as plain text so the conversation still moves, and say so in the result.
          if (unsupportedReason) {
            await sendMessage({
              apiUrl: config.apiUrl,
              botToken: config.botToken,
              channelId: coords.channelId,
              channelType: coords.channelType,
              content: baseline.plain,
              clientMsgNo: generateClientMsgNo(),
              signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });
            return jsonResult({
              sent: true,
              degraded: true,
              reason: unsupportedReason,
              channel_id: coords.channelId,
            });
          }

          const clientMsgNo = generateClientMsgNo();
          const result = await sendCardMessage({
            apiUrl: config.apiUrl,
            botToken: config.botToken,
            channelId: coords.channelId,
            channelType: coords.channelType,
            card: built.card,
            plain: built.plain,
            profile: CARD_INTERACTIVE_PROFILE as CardProfile,
            clientMsgNo,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
          const messageId = result?.message_id?.trim();
          if (!messageId) return errResult('interactive card send returned no message_id');

          // Register the card session so A8 can look it up when the click arrives. This also
          // lazily starts the owning bot's event poll loop (card-session → requestCardEventPolling).
          registerCardSession(messageId, {
            ...(sessionKey?.trim() ? { sessionKey } : {}),
            accountId: config.accountId,
            channelId: coords.channelId,
            channelType: coords.channelType,
            title: built.title,
            card: built.card,
            plain: built.plain,
            actionLabels: built.actionLabels,
            inputIds: built.inputIds,
            ...(negotiatedCaps?.maxInputTextBytes
              ? { maxInputTextBytes: negotiatedCaps.maxInputTextBytes }
              : {}),
            ...(negotiatedCaps?.maxInputsBytes ? { maxInputsBytes: negotiatedCaps.maxInputsBytes } : {}),
          });
          return jsonResult({
            sent: true,
            message_id: messageId,
            channel_id: coords.channelId,
            client_msg_no: clientMsgNo,
          });
        } catch (e) {
          return errResult(e instanceof Error ? e.message : String(e));
        }
      },
    ),
  ];
}

/**
 * Build the interactive-card MCP server for one agent turn. `coords` binds the
 * sent card to this session's channel; `sessionKey` ties the eventual click back
 * to the authoring session; `config` carries the bot wire credentials + identity.
 */
export function createInteractiveCardToolServer(
  config: InteractiveCardToolConfig,
  coords: InteractiveCardSessionCoords,
  sessionKey?: string,
) {
  return createSdkMcpServer({
    name: INTERACTIVE_CARD_TOOL_SERVER_NAME,
    version: '1.0.0',
    tools: buildInteractiveCardTools(config, coords, sessionKey),
  });
}
