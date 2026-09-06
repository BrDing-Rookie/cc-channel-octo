/**
 * C1 / C2: media-send tool — an in-process MCP server letting the agent post an
 * image / file (`octo_send_media`) or a mixed text+image RichText(=14) message
 * (`octo_send_rich_text`) to the CURRENT session's channel. The tools surface to
 * the model as `mcp__send_media__octo_send_media` /
 * `mcp__send_media__octo_send_rich_text`.
 *
 * The server is built PER TURN (`createMediaSendToolServer`) with the current
 * message's channel coords + the session cwd sandbox, so:
 *
 *   1. **Target is runtime-owned.** The delivery channel comes from the per-turn
 *      `coords`, never from tool arguments — a prompt-injected agent cannot make
 *      the bot post media into another conversation by passing a channelId.
 *   2. **Identity is always bot.** Media is sent as the bot's own identity; no
 *      OBO / persona-clone is ever derived from model input.
 *   3. **Local sources stay in the sandbox.** A local `path` is resolved relative
 *      to the session cwd and confined to it (see resolveMediaSource) — the agent
 *      cannot upload arbitrary host files. `http(s)` sources are SSRF-guarded and
 *      `data:` sources are size-capped, all in media-outbound.ts.
 *
 * All heavy lifting (resolve / size-cap / SSRF / presigned upload / dimension
 * parsing / wire send) lives in media-outbound.ts; this file is the tool shell.
 */

import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelType } from './octo/types.js';
import { sendMediaToChannel, sendRichTextToChannel } from './media-outbound.js';
import { docTaskImEgressBlockReason } from './doc-task-scope.js';

/** MCP server name; tools surface as `mcp__send_media__octo_send_*`. */
export const MEDIA_SEND_TOOL_SERVER_NAME = 'send_media';
export const SEND_MEDIA_TOOL_NAME = 'octo_send_media';
export const SEND_RICH_TEXT_TOOL_NAME = 'octo_send_rich_text';

/** Per-turn upper bound on how long a single send may take (download+upload). */
const SEND_TIMEOUT_MS = 300_000;
/** Max image sources accepted by one rich-text send. */
const MAX_RICH_TEXT_IMAGES = 9;

/** Channel coords + cwd sandbox of the session invoking the tool. */
export interface MediaSendSessionCoords {
  channelId: string;
  channelType: ChannelType;
  /** Session cwd sandbox — local media sources resolve relative to this. */
  cwdDir: string;
}

/** Bot wire credentials for this turn's account. */
export interface MediaSendToolConfig {
  apiUrl: string;
  botToken: string;
}

function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function errResult(msg: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

const SEND_MEDIA_DESCRIPTION =
  'Send ONE image or file to the CURRENT Octo conversation. The delivery channel ' +
  'comes from the trusted runtime session and CANNOT be selected by tool arguments; ' +
  'the media is always posted as the bot itself. Provide exactly one `source`: a path ' +
  'RELATIVE to your working directory (e.g. "chart.png" or "out/report.pdf" — absolute ' +
  'paths and file:// URLs are rejected), an http(s):// URL (fetched with SSRF protection), ' +
  'or a data: URI. Images are sent as an image message (dimensions parsed automatically); ' +
  'everything else as a file message. Optionally set `filename` to override the displayed ' +
  'name. There is a size cap; oversize sources are rejected. IMPORTANT — this is a ' +
  'side-effect that posts a message; it is NOT your conversational reply. After it returns ' +
  'you MUST still emit a short final text message to the user.';

const SEND_RICH_TEXT_DESCRIPTION =
  'Send ONE mixed text+image message (RichText) to the CURRENT Octo conversation, so a ' +
  'caption and its images land as a single message instead of separate sends. The delivery ' +
  'channel comes from the trusted runtime session and CANNOT be selected by tool arguments; ' +
  'the message is always posted as the bot itself. Provide `text` (the caption, may be empty) ' +
  'and `images` (an ordered list of image sources — each a working-directory-relative path, ' +
  'an http(s):// URL, or a data: URI; absolute paths / file:// are rejected). Non-image ' +
  'sources, or images whose dimensions cannot be parsed, are delivered as separate file/image ' +
  'messages instead of inline blocks. There is a per-image size cap. IMPORTANT — this is a ' +
  'side-effect that posts a message; it is NOT your conversational reply. After it returns you ' +
  'MUST still emit a short final text message to the user.';

/**
 * Build the media-send tool DEFINITIONS for one agent turn. Exported separately
 * from the server so tests can invoke the handlers directly. `coords` binds
 * every send to this session's channel + cwd; `config` carries wire credentials.
 */
export function buildMediaSendTools(
  config: MediaSendToolConfig,
  coords: MediaSendSessionCoords,
) {
  const guardConfigured = (): string | null => {
    if (!config.botToken || !config.apiUrl) return 'Octo account is not fully configured';
    if (!coords.channelId || !coords.channelId.trim()) {
      return 'the current Octo delivery channel is unavailable';
    }
    // D3 egress fail-closed: a doc-task session has no IM destination, so both
    // media sends bind to a non-routable sentinel channel. Refuse here (shared by
    // both tools) rather than let the send hit a bogus channel.
    const docTaskBlock = docTaskImEgressBlockReason(coords.channelId, `${SEND_MEDIA_TOOL_NAME}/${SEND_RICH_TEXT_TOOL_NAME}`);
    if (docTaskBlock) return docTaskBlock;
    return null;
  };

  return [
    tool(
      SEND_MEDIA_TOOL_NAME,
      SEND_MEDIA_DESCRIPTION,
      {
        source: z
          .string()
          .min(1)
          .describe(
            'The media to send: a working-directory-relative path, an http(s):// URL, ' +
              'or a data: URI. Absolute paths and file:// URLs are rejected.',
          ),
        filename: z
          .string()
          .optional()
          .describe('Optional display filename override (e.g. "summary.pdf").'),
      },
      async (args) => {
        const bad = guardConfigured();
        if (bad) return errResult(bad);
        try {
          const result = await sendMediaToChannel({
            source: args.source,
            cwdDir: coords.cwdDir,
            apiUrl: config.apiUrl,
            botToken: config.botToken,
            channelId: coords.channelId,
            channelType: coords.channelType,
            filenameHint: typeof args.filename === 'string' ? args.filename : undefined,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
          return jsonResult({
            sent: {
              message_id: result.messageId,
              channel_id: coords.channelId,
              type: result.type,
              filename: result.filename,
              size: result.size,
              ...(result.width ? { width: result.width, height: result.height } : {}),
            },
          });
        } catch (e) {
          return errResult(e instanceof Error ? e.message : String(e));
        }
      },
    ),
    tool(
      SEND_RICH_TEXT_TOOL_NAME,
      SEND_RICH_TEXT_DESCRIPTION,
      {
        text: z.string().describe('The caption/body text. May be empty for images-only.'),
        images: z
          .array(z.string().min(1))
          .max(MAX_RICH_TEXT_IMAGES)
          .describe(
            'Ordered image sources (working-directory-relative path, http(s):// URL, or ' +
              'data: URI). Non-image or dimensionless sources are delivered as separate messages.',
          ),
      },
      async (args) => {
        const bad = guardConfigured();
        if (bad) return errResult(bad);
        const text = typeof args.text === 'string' ? args.text : '';
        const images = Array.isArray(args.images) ? args.images.filter((s) => typeof s === 'string' && s.trim()) : [];
        if (text.trim() === '' && images.length === 0) {
          return errResult('provide non-empty text and/or at least one image source');
        }
        try {
          const result = await sendRichTextToChannel({
            text,
            images,
            cwdDir: coords.cwdDir,
            apiUrl: config.apiUrl,
            botToken: config.botToken,
            channelId: coords.channelId,
            channelType: coords.channelType,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
          // A total failure (nothing delivered AND every image errored) surfaces
          // as a tool error so the agent can fall back to a plain text reply.
          if (!result.messageId && result.imageCount === 0 && result.failedMedia.length > 0) {
            return errResult(
              `failed to send: ${result.failedMedia.map((f) => f.error).join('; ')}`,
            );
          }
          return jsonResult({
            sent: {
              message_id: result.messageId,
              channel_id: coords.channelId,
              rich_text: result.richText,
              images_delivered: result.imageCount,
              ...(result.failedMedia.length > 0 ? { failed: result.failedMedia } : {}),
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
 * Build the media-send MCP server for one agent turn. `coords` binds sends to
 * this session's channel + cwd; `config` carries the bot wire credentials.
 */
export function createMediaSendToolServer(
  config: MediaSendToolConfig,
  coords: MediaSendSessionCoords,
) {
  return createSdkMcpServer({
    name: MEDIA_SEND_TOOL_SERVER_NAME,
    version: '1.0.0',
    tools: buildMediaSendTools(config, coords),
  });
}
