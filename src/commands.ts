/**
 * In-chat slash commands (v0.3).
 *
 * Users can control their session without leaving the chat:
 *   /reset            — clear this session's conversation history
 *   /config           — show the effective per-session settings
 *   /help             — list available commands
 *
 * Commands are matched on the FIRST line of the cleaned message text (after the
 * router has stripped any leading @bot mention), so `@bot /reset` works in
 * groups. Matching is case-insensitive and tolerant of surrounding whitespace.
 *
 * A command is scoped to the sessionKey of the message. In a group the session
 * is shared per channel, so `/reset` clears the WHOLE group's conversation
 * history (every member shares one session), not just the caller's. In a DM it
 * clears that peer's history. Note: it does NOT clear long-term auto-memory.
 *
 * Note: commands are handled inside the router's processing callback, AFTER the
 * per-session rate limit is applied. A user who has exhausted their token bucket
 * therefore cannot run `/reset` or `/help` until it refills — control commands
 * are rate-limited like normal messages. This is intentional (a flooder should
 * not get a rate-limit bypass via slash commands); documented in the README.
 */

import type { Config } from './config.js';
import type { SessionStore } from './session-store.js';
import { extractParentGroupNo, THREAD_ID_SEPARATOR } from './octo/channel-id.js';
import { listSkins, parseSkinId, resolveSkin, DEFAULT_SKIN_ID, type SkinId } from './card-skins.js';

/** Result of attempting to handle a command. */
export interface CommandResult {
  /** True when the text was a recognized command and was handled. */
  handled: boolean;
  /** Reply to send back to the user (only meaningful when handled). */
  reply?: string;
}

/** Not a command at all — let the normal agent pipeline take over. */
const NOT_A_COMMAND: CommandResult = { handled: false };

/**
 * Parse the command token from a message body. Returns the lowercased command
 * name (without the leading slash) and the trimmed argument string, or null
 * when the text does not start with a slash command.
 *
 * Only the first whitespace-delimited token on the first line is considered, so
 * a message that merely mentions "/reset" mid-sentence is NOT treated as a
 * command — it must lead.
 */
export function parseCommand(
  body: string,
): { name: string; args: string } | null {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? '';
  // The command name must be followed by a TOKEN BOUNDARY — end-of-line or
  // whitespace — before any args. Without this, path/route-like text such as
  // `/reset/foo`, `/config.json`, or `/help.md` would be parsed as the bare
  // command and could trigger a destructive action (`/reset`). Requiring `\s+`
  // (or EOL) after the name means only a real command token matches; anything
  // glued to the name (`/foo.bar`, `/a/b`) is NOT a command and falls through
  // to the normal agent pipeline.
  const match = firstLine.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/** Human-readable list of supported commands. */
const HELP_TEXT = [
  'Available commands:',
  '• `/reset` — clear the conversation history for this session (the whole group, in a group chat); does not clear long-term memory',
  '• `/config` — show the current session settings',
  '• `/skins [id]` — list card visual styles, or switch this session to one (terminal / dashboard / editorial / signal)',
  '• `/fork [name]` — (owner, in a group/thread) branch this conversation into a new thread that carries the context so far',
  '• `/help` — show this message',
].join('\n');

/**
 * `/skins` handler. Bare `/skins` lists the registered skins and marks the active one;
 * `/skins <id>` switches this session's active skin (persisted per session). The default
 * (when a session has never chosen) is the per-bot `sdk.defaultSkin`, else the product default.
 * Session-scoped like every other command: in a group, the whole channel shares one skin.
 */
export function handleSkinsCommand(
  args: string,
  sessionKey: string,
  store: SessionStore,
  config: Config,
): CommandResult {
  const perBotDefault = resolveSkin(config.sdk.defaultSkin ?? DEFAULT_SKIN_ID).id;
  const current: SkinId = (store.getActiveSkin(sessionKey) as SkinId | undefined) ?? perBotDefault;

  if (!args) {
    const lines = ['Card skins (active = ★):'];
    for (const s of listSkins()) {
      const mark = s.id === current ? '★' : '•';
      lines.push(`${mark} \`${s.id}\` — ${s.blurb}`);
    }
    lines.push('', 'Switch with `/skins <id>` (e.g. `/skins editorial`).');
    return { handled: true, reply: lines.join('\n') };
  }

  const target = parseSkinId(args);
  if (!target) {
    const ids = listSkins().map((s) => s.id).join(' / ');
    return { handled: true, reply: `Unknown skin: "${args}". Choose one of: ${ids}.` };
  }
  if (target === current) {
    return { handled: true, reply: `Already using the "${target}" skin.` };
  }
  store.setActiveSkin(sessionKey, target);
  return { handled: true, reply: `✓ Card skin switched to "${target}". New cards in this session use it.` };
}

/**
 * Render the effective, non-sensitive per-session configuration. Deliberately
 * omits secrets (botToken, apiUrl host details beyond scheme) — this reply is
 * visible to any user who can message the bot.
 */
function renderConfig(config: Config): string {
  const tools =
    config.sdk.allowedTools === '*'
      ? '* (all SDK tools)'
      : config.sdk.allowedTools.join(', ');
  return [
    'Current settings:',
    `• model: ${config.sdk.model ?? '(SDK default)'}`,
    `• allowedTools: ${tools}`,
    `• permissionMode: ${config.sdk.permissionMode}`,
    `• rateLimit: ${config.rateLimit.maxPerMinute} req/min`,
    `• historyLimit: ${config.context.historyLimit} messages`,
  ].join('\n');
}

/**
 * Try to handle `body` as a slash command for the given session.
 *
 * Returns `{ handled: false }` when the text is not a command (caller proceeds
 * with the normal agent pipeline). When handled, returns the reply to send and
 * performs any side effect (e.g. clearing history) immediately.
 *
 * `messageSeq` is the seq of the command message itself; `/reset` records it as
 * a persisted barrier so cold-start group backfill cannot resurrect pre-reset
 * history on a later turn.
 */
export function handleCommand(
  body: string,
  sessionKey: string,
  store: SessionStore,
  config: Config,
  messageSeq?: number,
): CommandResult {
  const parsed = parseCommand(body);
  if (!parsed) return NOT_A_COMMAND;

  switch (parsed.name) {
    case 'reset': {
      // Scoped to THIS sessionKey. In a group the session is shared per channel,
      // so this clears the whole group's conversation history; in a DM it clears
      // that peer's. Long-term auto-memory (under memoryBase) is NOT cleared.
      store.deleteSession(sessionKey);
      // Persist a barrier at this message_seq so G4 cold-start backfill (which
      // refetches channel history when the local cache is empty) cannot
      // re-seed the history we just cleared — even across a process restart.
      if (messageSeq !== undefined) {
        store.setResetBarrier(sessionKey, messageSeq);
      }
      // v0.3 persistent sessions: also forget the SDK session id, otherwise the
      // next turn would `resume` it and bring the just-cleared conversation back.
      store.clearSdkSessionId(sessionKey);
      return { handled: true, reply: '✓ Conversation history cleared (long-term memory is kept).' };
    }
    case 'config': {
      return { handled: true, reply: renderConfig(config) };
    }
    case 'skins': {
      return handleSkinsCommand(parsed.args, sessionKey, store, config);
    }
    case 'help': {
      return { handled: true, reply: HELP_TEXT };
    }
    default:
      // A leading-slash token we don't recognize. Report it rather than
      // silently forwarding to the agent, so typos are visible.
      return {
        handled: true,
        reply: `Unknown command: /${parsed.name}\n\n${HELP_TEXT}`,
      };
  }
}

/**
 * G1: dependencies for `/fork`. Injected (rather than importing the wire/SDK
 * calls directly) so the handler is pure-logic and unit-testable with fakes, and
 * so commands.ts stays free of network/SDK imports. Built per-turn in index.ts
 * from the current message's channel coords + config.
 */
export interface ForkCommandDeps {
  /** Trimmed argument string (`parseCommand(...).args`) — used as the thread name. */
  args: string;
  /** The CURRENT (parent) session key = the channel_id of this group/thread. */
  parentSessionKey: string;
  /**
   * The cwd-anchor key the child should point at — the parent's OWN anchor if the
   * parent is itself a fork (so a fork-of-a-fork flattens to the same root bucket
   * the SDK session files live in), else the parent session key. index.ts resolves
   * this from `store.getForkParent(parentSessionKey) ?? parentSessionKey`, matching
   * how it derives `parentCwd`.
   */
  parentAnchorKey: string;
  /** The current channel_id (group `<groupNo>` or thread `<groupNo>____<shortId>`). */
  channelId: string;
  /** False for a DM — a DM has no group to create a thread in, so /fork is refused. */
  isGroup: boolean;
  /** uid of the human who issued /fork. */
  requesterUid: string;
  /** The bot owner uid. /fork is owner-only. */
  ownerUid: string;
  /** config.sdk.octoManagement — thread creation needs the management surface on. */
  octoManagementEnabled: boolean;
  /** The bot's own token; thread management requires a User-Bot (`bf_`) token. */
  botToken: string;
  /** The parent session's cwd dir — where forkSdkSession must write the fork. */
  parentCwd: string;
  /** Narrowed store surface: read the parent SDK session, seed the child + anchor. */
  store: Pick<SessionStore, 'getSdkSessionId' | 'setSdkSessionId' | 'setForkParent'>;
  /** Create a thread under `groupNo`; resolves to its short_id + name, or null on failure. */
  createThread: (groupNo: string, name: string) => Promise<{ shortId: string; name: string } | null>;
  /** Fork the parent SDK session (dir = parentCwd); resolves to the new session id, or null. */
  forkSdkSession: (parentSdkSessionId: string, dir: string) => Promise<string | null>;
  /** Emit a structured audit line for the owner-gated operation. */
  audit: (result: 'allowed' | 'denied', reason?: string) => void;
}

/** Default thread name when the user runs a bare `/fork` (no argument). */
const DEFAULT_FORK_THREAD_NAME = 'Forked conversation';

/**
 * G1: handle `/fork [name]` — branch the current conversation into a NEW Octo
 * thread that continues with the full context so far, while this chat carries on
 * independently. Approach A (see PR): the child thread reuses the PARENT's cwd
 * bucket so the forked SDK session file stays resumable; only the SDK conversation
 * diverges. Parent's stored SDK session id is never rewritten.
 *
 * Owner-only + audited. Requires a group/thread context (a DM has no group),
 * `sdk.octoManagement`, and a User-Bot (`bf_`) token. Any unmet precondition or
 * downstream failure degrades to a plain-text reply — never a silent no-op.
 *
 * Kept async + dependency-injected (see ForkCommandDeps) so it is unit-testable
 * without a live server/SDK; index.ts intercepts `/fork` before handleCommand and
 * wires the real createThread / forkSdkSession / audit.
 */
export async function handleForkCommand(deps: ForkCommandDeps): Promise<CommandResult> {
  // 1. Context gate: a DM has no group_no, so there is no thread to create.
  if (!deps.isGroup) {
    return {
      handled: true,
      reply: '/fork only works in a group or thread — a direct message has no group to branch into.',
    };
  }

  // 2. Owner gate (audited) — /fork copies the whole conversation into a new
  //    thread, a sensitive action kept at the same owner-only bar as createThread.
  if (!deps.requesterUid || deps.requesterUid !== deps.ownerUid) {
    deps.audit('denied', 'owner-only');
    return { handled: true, reply: '/fork is limited to the bot owner.' };
  }

  // 3. Dependency gates — surface each as a prompt (never fail silently).
  if (!deps.octoManagementEnabled) {
    return {
      handled: true,
      reply: '/fork needs group management enabled for this bot (set sdk.octoManagement).',
    };
  }
  if (!deps.botToken.startsWith('bf_')) {
    return {
      handled: true,
      reply: '/fork requires a User-Bot (bf_) token — this bot cannot create threads.',
    };
  }

  // 4. There must be a parent SDK session to fork from.
  const parentSdkId = deps.store.getSdkSessionId(deps.parentSessionKey);
  if (!parentSdkId) {
    return {
      handled: true,
      reply: 'Nothing to fork yet — send a message or two here first, then /fork.',
    };
  }

  // 5. Create the thread under the parent group (a thread channelId forks off its
  //    parent groupNo, never a nested thread).
  const groupNo = extractParentGroupNo(deps.channelId);
  if (!groupNo) {
    return { handled: true, reply: 'Could not determine the parent group for this conversation.' };
  }
  const threadName = deps.args.trim() || DEFAULT_FORK_THREAD_NAME;
  const thread = await deps.createThread(groupNo, threadName);
  if (!thread) {
    deps.audit('denied', 'create-thread failed');
    return {
      handled: true,
      reply: 'Could not create the thread — the server rejected it (a User-Bot token and group membership are required).',
    };
  }

  const childSessionKey = `${groupNo}${THREAD_ID_SEPARATOR}${thread.shortId}`;

  // 6. Fork the SDK session into the child (dir = parent cwd, so the fork lands in
  //    the bucket the child will resume from). On failure the thread already
  //    exists — report honestly that it will start without the parent's context
  //    rather than pretend it forked.
  const forkedId = await deps.forkSdkSession(parentSdkId, deps.parentCwd);
  if (!forkedId) {
    deps.audit('denied', 'fork-session failed');
    return {
      handled: true,
      reply: `Created the thread "${thread.name}", but branching the conversation failed — it will start fresh there instead of carrying this context.`,
    };
  }

  // 7. Seed the child: point its SDK session at the fork and anchor its cwd to the
  //    parent's bucket. Done only after BOTH network + SDK steps succeed, so a
  //    partial failure never leaves a dangling anchor. Parent id is untouched.
  deps.store.setSdkSessionId(childSessionKey, forkedId);
  deps.store.setForkParent(childSessionKey, deps.parentAnchorKey);
  deps.audit('allowed');

  return {
    handled: true,
    reply: `✓ Forked this conversation into a new thread "${thread.name}". Continue there — it carries the full context so far; this chat stays separate.`,
  };
}
