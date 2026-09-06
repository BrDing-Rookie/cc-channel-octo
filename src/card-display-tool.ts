/**
 * A9: display-card tool — an in-process MCP server letting the agent post a
 * DISPLAY InteractiveCard(=17) to the CURRENT session's channel. The tool
 * surfaces to the model as `mcp__display_card__octo_send_display_card`.
 *
 * The server is built PER TURN (`createDisplayCardToolServer`) with the current
 * message's channel coords, so a sent card always lands in the session that
 * asked for it. Two invariants are enforced server-side (not by LLM judgment,
 * since the agent is driven by untrusted IM users):
 *
 *   1. **Target is runtime-owned.** The delivery channel comes from the per-turn
 *      `coords`, never from tool arguments — a prompt-injected agent cannot make
 *      the bot post a card into another conversation by passing a channelId.
 *   2. **Identity is always bot.** The card is sent as the bot's own identity;
 *      OBO / persona-clone is NEVER derived from model input (a group-visible
 *      card must not become a persona-impersonation sink). Mirrors the wire
 *      layer: type-17 + OBO is rejected server-side anyway (P1 Decision 2b).
 *
 * Fail-closed gateway: the D12 card profile (GET /v1/bot/card/profile, see
 * octo/api.ts `getCardProfile`) is consulted before every send. Display cards
 * are rejected unless the server Bot policy explicitly advertises them
 * (`config.display_enabled === true`), the negotiated profile includes
 * `octo/v1`, `card_version` is compatible, and `TextBlock` is advertised — any
 * missing/malformed manifest degrades to "disabled", never a local fallback.
 *
 * Content safety rides on the A3 pure layer: `validateDisplayBlocks` whitelists
 * the agent-controlled `blocks` structurally, and `buildDisplayCard` desensitizes
 * every block (URL reduction / secret-shape removal) and negotiates element
 * degradation against the server caps. The agent never needs to check
 * compatibility or redact itself.
 */

import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelType } from './octo/types.js';
import { CARD_PROFILE, CARD_VERSION } from './octo/types.js';
import { buildDisplayCard, validateDisplayBlocks } from './card-blocks.js';
import { docTaskImEgressBlockReason } from './doc-task-scope.js';
import {
  getCardProfile,
  deriveCardCaps,
  sendCardMessage,
  generateClientMsgNo,
  type CardProfileManifest,
} from './octo/api.js';

/** MCP server name; the tool surfaces as `mcp__display_card__octo_send_display_card`. */
export const DISPLAY_CARD_TOOL_SERVER_NAME = 'display_card';
/** Tool name inside the server (matches the openclaw parity name). */
export const DISPLAY_CARD_TOOL_NAME = 'octo_send_display_card';

/** Display-card send timeout — the wire POST has no default, so bound it here. */
const SEND_TIMEOUT_MS = 15_000;

/** Raw coords of the session invoking the tool — what a sent card is delivered to. */
export interface DisplayCardSessionCoords {
  channelId: string;
  channelType: ChannelType;
}

/** Bot wire credentials for this turn's account. */
export interface DisplayCardToolConfig {
  apiUrl: string;
  botToken: string;
}

function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function errResult(msg: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

/**
 * Fail-closed gate: reject unless the server Bot policy explicitly allows display
 * cards, advertises the octo/v1 profile, uses a compatible card_version, and
 * advertises TextBlock (the universal degrade target). No local config fallback —
 * an unavailable / malformed manifest reads as "disabled".
 */
export function displayCardGateReason(m: CardProfileManifest): string | null {
  if (!m.available || m.config?.display_enabled !== true) {
    return 'display cards are disabled by the server Bot policy';
  }
  if (Array.isArray(m.profiles) && m.profiles.length > 0 && !m.profiles.includes(CARD_PROFILE)) {
    return `profile ${CARD_PROFILE} not advertised by server (got: ${m.profiles.join(',')})`;
  }
  if (typeof m.card_version === 'string' && m.card_version !== CARD_VERSION) {
    return `card_version ${m.card_version} not compatible (need ${CARD_VERSION})`;
  }
  if (Array.isArray(m.elements) && !m.elements.includes('TextBlock')) {
    return 'TextBlock is not advertised; no safe display-card fallback is available';
  }
  return null;
}

const TOOL_DESCRIPTION =
  'Send a DISPLAY card (Adaptive Card 1.5) to the CURRENT Octo conversation. The target ' +
  'channel comes from the trusted runtime session and CANNOT be selected by tool arguments; ' +
  'the card is always posted as the bot itself. Use this for rich, structured, NON-INTERACTIVE ' +
  'output — status reports, structured answers, key-value summaries, three-column KPI/weather ' +
  'strips, tables, collapsible detail sections, local copy-to-clipboard buttons, and safe ' +
  'navigation links. The card does NOT have callback buttons and will NOT trigger any callback ' +
  'event. Provide `blocks`, an ordered list of typed display blocks (heading / text / rich / ' +
  'facts / columns / table / link / group / collapsible / copy); the server-advertised ' +
  'element/action set is negotiated automatically and unsupported types degrade to plain text — ' +
  'you never need to check compatibility yourself. For visual emphasis use `group` block styles ' +
  'sparingly (`emphasis` for neutral callouts; `good` / `warning` / `attention` only for real ' +
  'success / pending / risk states); prefer highlighting key tokens with `rich` segment colors ' +
  'over recoloring whole lines. Design for IM: the first screen should be a 3-6 line summary, ' +
  'not a log dump — one title, a compact summary, and fold long detail behind a `collapsible`. ' +
  '`plain` fallback text is generated automatically from the same blocks. Content is fully ' +
  'visible to all group members: never put secrets or tokens into any field (they are ' +
  'desensitized, but do not rely on it). IMPORTANT — this tool is a side-effect that posts a ' +
  'card; it is NOT your conversational reply. After it returns you MUST still emit a short final ' +
  'text message to the user; a turn that ends on a bare tool call with no text is shown as an ' +
  'interrupted/failed turn.';

/**
 * Build the display-card tool DEFINITIONS for one agent turn. Exported separately
 * from the server so tests can invoke the handler directly. `coords` binds the
 * sent card to this session's channel; `config` carries the bot wire credentials.
 */
export function buildDisplayCardTools(
  config: DisplayCardToolConfig,
  coords: DisplayCardSessionCoords,
) {
  return [
    tool(
      DISPLAY_CARD_TOOL_NAME,
      TOOL_DESCRIPTION,
      {
        title: z.string().optional().describe('Optional bold title rendered at the top of the card.'),
        blocks: z
          .array(z.record(z.string(), z.unknown()))
          .describe(
            'Ordered list of DisplayBlock. Each block is one of: ' +
              "{type:'heading', text, size?:'medium'|'large'} · " +
              "{type:'text', text} · " +
              "{type:'rich', segments:[{text, bold?, subtle?, fontType?:'Monospace', color?:'good'|'warning'|'attention'|'accent'}]} · " +
              "{type:'facts', items:[{label, value}]} · " +
              "{type:'columns', columns:[{blocks:[…]}]} · " +
              "{type:'table', columns?:[{width:number}], rows:[{cells:[{text}|{blocks:[…]}]}], firstRowAsHeader?:boolean} · " +
              "{type:'link', text, url} · " +
              "{type:'group', style?:'good'|'warning'|'attention'|'emphasis', blocks:[…]} · " +
              "{type:'collapsible', summary, actionLabel?, expandLabel?, collapseLabel?, defaultVisible?, blocks:[…]} · " +
              "{type:'copy', label?, text}. " +
              'Unknown block types or missing fields are silently dropped.',
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
          const docTaskBlock = docTaskImEgressBlockReason(coords.channelId, DISPLAY_CARD_TOOL_NAME);
          if (docTaskBlock) return errResult(docTaskBlock);
          const validated = validateDisplayBlocks(args.blocks);
          const rawTitle = typeof args.title === 'string' ? args.title : '';

          // D12 capability probe (gate + caps). getCardProfile is fail-closed: a
          // 404 yields { available:false }, a malformed body yields enabled:false,
          // and transport / 5xx throws (caught below) — never a local fallback.
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
          const rejection = displayCardGateReason(manifest);
          if (rejection) {
            return errResult(`${rejection}. Send your reply as a plain text message instead.`);
          }

          // Build + negotiate degradation + desensitize — buildDisplayCard is the
          // single authority. caps come from the server manifest.
          const { card, plain } = buildDisplayCard({
            title: rawTitle,
            blocks: validated,
            caps: deriveCardCaps(manifest),
          });
          const body = (card.body as unknown[]) ?? [];
          if (body.length === 0) {
            return errResult('card is empty (no valid blocks after validation)');
          }

          // Delivery target is the runtime-owned session channel; tool arguments
          // never route or authorize. Identity is always the bot itself — no
          // on_behalf_of is ever set from model input.
          const clientMsgNo = generateClientMsgNo();
          const result = await sendCardMessage({
            apiUrl: config.apiUrl,
            botToken: config.botToken,
            channelId: coords.channelId,
            channelType: coords.channelType,
            card,
            plain,
            clientMsgNo,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });

          const messageId = result?.message_id ?? '';
          return jsonResult({
            sent: {
              message_id: messageId,
              channel_id: coords.channelId,
              client_msg_no: clientMsgNo,
              elements: body.length,
            },
          });
        } catch (e) {
          return errResult(e instanceof Error ? e.message : String(e));
        }
      },
    ),
  ];
}

/**
 * Build the display-card MCP server for one agent turn. `coords` binds the sent
 * card to this session's channel; `config` carries the bot wire credentials.
 */
export function createDisplayCardToolServer(
  config: DisplayCardToolConfig,
  coords: DisplayCardSessionCoords,
) {
  return createSdkMcpServer({
    name: DISPLAY_CARD_TOOL_SERVER_NAME,
    version: '1.0.0',
    tools: buildDisplayCardTools(config, coords),
  });
}
