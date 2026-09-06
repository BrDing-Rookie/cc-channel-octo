/**
 * B10: `octo_secret` — an in-process MCP tool with a single `write-secret`
 * action. It resolves ONE of the bot owner's stored secrets (via the batch-0
 * `resolveSecret` endpoint) and writes the plaintext into a file inside the
 * current session's cwd sandbox, then returns a plaintext-free result.
 *
 * Surfaces to the model as `mcp__octo_secret__octo_secret`.
 *
 * 🔴 SECURITY — this tool writes the owner's PLAINTEXT secret to disk, driven by
 * an LLM whose tool arguments (`filePath`, `template`) are reachable from
 * untrusted, prompt-injectable group chat. Three layers defend it:
 *   1. OWNER GATE + audit — only the bot owner's turn may invoke it (防误; the
 *      real hard boundary is the bot's enabled tool set under bypassPermissions,
 *      same posture as the cron / management tools).
 *   2. FS JAIL — the destination is confined to an operator-approved root (the
 *      session cwd sandbox by default, or an explicit `secretsFileRoot`). `..`
 *      traversal, absolute-elsewhere paths, and symlink escapes (resolved,
 *      dangling, or unverifiable) are rejected; the write uses O_NOFOLLOW to
 *      defeat a TOCTOU symlink swap, and forces mode 0o600.
 *   3. PLAINTEXT CONTAINMENT — the resolved value only ever lives in a local
 *      variable and the file; it NEVER enters the tool arguments, the return
 *      value, an error message, or a log. Ambiguity returns label-only
 *      candidates; the success payload is `{written, path (jail-relative), mode,
 *      display_name?}` with no value / content / byte length.
 *
 * The FS-jail primitives (`isInsideRoot`, `confineSecretPath`,
 * `canonicalizeThroughExisting`, `isFilesystemRoot`) are ported from
 * openclaw-channel-octo's write-secret, with the jail root swapped from
 * openclaw's platform agent-workspace resolver to cc's per-session cwd sandbox
 * (`resolveSessionCwd`, supplied by the caller as `coords.cwdDir`).
 */
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, realpath, lstat, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, isAbsolute, parse as parsePath, relative, resolve as resolvePath, sep } from "node:path";
import { resolveSecret } from "./octo/api.js";
import { emitAuditLog } from "./audit.js";
import { docTaskImEgressBlockReason } from "./doc-task-scope.js";

/** MCP server name; the tool surfaces as `mcp__octo_secret__octo_secret`. */
export const OCTO_SECRET_TOOL_SERVER_NAME = "octo_secret";
export const OCTO_SECRET_TOOL_NAME = "octo_secret";

/**
 * Placeholder token replaced by the resolved plaintext inside the caller-supplied
 * write template. An explicit token keeps the LLM in control of HOW the secret is
 * laid out (env line, JSON field, raw value) while the plaintext itself only ever
 * materializes inside the tool — never in the tool arguments or return value.
 */
const SECRET_PLACEHOLDER = "{{secret}}";

/** Owner read/write only. A file holding a plaintext key must not be group/world readable. */
const SECRET_FILE_MODE = 0o600;

const OP_TIMEOUT_MS = 30_000;

/**
 * Containment test: is `candidate` the jail `root` itself or a path strictly
 * beneath it? Uses `path.relative` rather than `root + sep` string-prefix
 * matching, which has two production-biting failure modes (a `/` root self-locks
 * the jail; patching that the other way fails open). The relative form has
 * neither: inside iff the relative path is empty (candidate === root), does not
 * climb out (`..`), and is not itself absolute (different root/drive). The same
 * predicate is reused at every containment site so they cannot drift.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/** True iff `p` is a filesystem root (`/`, or a Windows drive root). */
function isFilesystemRoot(p: string): boolean {
  return parsePath(p).root === p;
}

/**
 * Canonicalize an absolute path through its NEAREST EXISTING ANCESTOR.
 *
 * `realpath(p)` throws ENOENT the moment any component does not yet exist — the
 * common case for a jail root on its first write. Falling back to the LEXICAL
 * form there makes the stored root diverge from the post-mkdir `realpath(dir)`
 * whenever any ancestor is a symlink (macOS `/tmp`→`/private/tmp`, bind-mounts,
 * a symlinked `$HOME`), false-rejecting a legitimate write. So canonicalize the
 * deepest existing ancestor and re-append the missing tail: symlink-free for
 * every component that could be a symlink, consistent with downstream checks.
 */
async function canonicalizeThroughExisting(absInput: string): Promise<string> {
  const abs = resolvePath(absInput);
  let dir = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(dir);
      return tail.length ? resolvePath(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        // Reached the filesystem root and even it didn't resolve — fall back to
        // the lexical absolute form (no symlink can hide above the root).
        return abs;
      }
      tail.push(basename(dir));
      dir = parent;
    }
  }
}

/**
 * Confine a caller-supplied write target to the operator-approved jail root.
 *
 * 🔴 `filePath` comes from the LLM tool call (prompt-injectable via group chat).
 * Without confinement, write-secret is an arbitrary-file-write of the owner's
 * plaintext (e.g. "append my key to ~/.bashrc" / ".ssh/authorized_keys"). The
 * owner triggering the turn does NOT make the jail redundant — the caller that
 * picks the path is injectable, so this jail is the only boundary between an
 * injected instruction and an arbitrary owner-writable file.
 *
 * 🔴 FAIL-CLOSED: refuse when no usable (non-filesystem-root) jail resolves —
 * never fall back to process.cwd(). Rejects `..` traversal, absolute-elsewhere,
 * and symlink escapes (resolved / dangling / unverifiable). Returns the safe
 * absolute path, or an error string that echoes ONLY the caller-typed path
 * (never secret material).
 */
async function confineSecretPath(
  filePath: string,
  rootInput: string | undefined,
): Promise<{ ok: true; abs: string; root: string } | { ok: false; error: string }> {
  const rootRaw = rootInput?.trim();
  if (!rootRaw) {
    return {
      ok: false,
      error:
        "write-secret is not configured: no jail root could be resolved. This should not happen (the session cwd sandbox is the default root); set an explicit sdk.secretsFileRoot to narrow it.",
    };
  }

  // Canonicalize through the nearest existing ancestor (see the helper) so the
  // stored root is symlink-free and consistent with the post-mkdir realpath.
  const root = await canonicalizeThroughExisting(rootRaw);

  // A jail root that is the filesystem root is degenerate (writes anywhere) —
  // refuse rather than run a root-wide jail.
  if (isFilesystemRoot(root)) {
    return {
      ok: false,
      error: "write-secret refuses to run with the filesystem root as its jail. Configure a real sdk.secretsFileRoot or session sandbox.",
    };
  }

  // resolvePath collapses `..`/`.`; an absolute filePath replaces root entirely,
  // which the containment check then rejects unless it still lands inside root.
  const candidate = resolvePath(root, filePath);

  if (!isInsideRoot(root, candidate)) {
    return {
      ok: false,
      error: `Refusing to write the secret outside the allowed directory. "${filePath}" resolves outside the permitted root. Use a path inside the workspace.`,
    };
  }

  // Symlink-escape guard: walk root→target one component at a time. A symlink
  // whose canonical target stays inside → keep walking; one that escapes →
  // reject; one that does NOT resolve (dangling/unverifiable) → reject
  // UNCONDITIONALLY (writeFile would follow it out of the jail); a component that
  // simply does not exist → deeper parts will be freshly created inside the
  // validated jail, so stop.
  const rel = candidate === root ? "" : relative(root, candidate);
  const segments = rel ? rel.split(sep) : [];
  let current = root;
  for (const seg of segments) {
    current = `${current}${sep}${seg}`;
    let st;
    try {
      st = await lstat(current);
    } catch {
      break;
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = await realpath(current);
      } catch {
        return {
          ok: false,
          error: `Refusing to write the secret: "${filePath}" passes through a symlink that cannot be verified to stay inside the allowed directory.`,
        };
      }
      if (!isInsideRoot(root, real)) {
        return {
          ok: false,
          error: `Refusing to write the secret: "${filePath}" resolves through a symlink that escapes the allowed directory.`,
        };
      }
    }
  }

  return { ok: true, abs: candidate, root };
}

export interface OctoSecretSessionCoords {
  /** Current session channel id (for the D3 doc-task egress guard). */
  channelId?: string;
  /** uid of the human who drove this turn — subject of the owner gate + audit. */
  requesterUid: string;
  /** Bot owner uid (registerBot.owner_uid); empty string when unknown. */
  ownerUid: string;
  /**
   * Absolute path of this session's cwd sandbox (`resolveSessionCwd`), used as
   * the DEFAULT jail root. `config.secretsFileRoot` wins over it when set.
   */
  cwdDir: string;
}

export interface OctoSecretToolConfig {
  apiUrl: string;
  botToken: string;
  /** Optional explicit jail root; wins over the session cwd sandbox. */
  secretsFileRoot?: string;
}

function jsonResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function errResult(msg: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

const OCTO_SECRET_DESCRIPTION =
  "Materialize one of the OWNER's stored secrets into a file (owner-only). Given " +
  "an `alias` (a secret's display name or id), resolve its current value and write " +
  "it to `filePath` INSIDE the session workspace. Optionally wrap it with a " +
  "`template` containing the token `{{secret}}` (e.g. `OPENAI_API_KEY={{secret}}`); " +
  "without a template the raw value is written. `mode` is `overwrite` (default) or " +
  "`append`. The path is confined to the workspace (no `..`, no symlink escape); " +
  "the file is created 0o600. The plaintext is NEVER returned — the result only " +
  "reports the written path (relative to the workspace) and mode. On an ambiguous " +
  "alias it returns candidate labels so you can ask the user which one.";

export function buildOctoSecretTools(
  config: OctoSecretToolConfig,
  coords: OctoSecretSessionCoords,
) {
  const isOwner = coords.ownerUid !== "" && coords.requesterUid === coords.ownerUid;

  return [
    tool(
      OCTO_SECRET_TOOL_NAME,
      OCTO_SECRET_DESCRIPTION,
      {
        alias: z.string().describe("The stored secret to resolve: its display name or secret_id."),
        filePath: z.string().describe("Destination path INSIDE the session workspace (relative; no `..`/symlink escape)."),
        template: z.string().optional().describe("Optional layout containing the `{{secret}}` token; omit to write the raw value."),
        mode: z.enum(["overwrite", "append"]).optional().describe("overwrite (default) or append."),
      },
      async (args) => {
        const { apiUrl, botToken } = config;
        if (!botToken || !apiUrl) return errResult("Octo account is not fully configured");

        // Defense-in-depth: a doc-task session must not materialize owner secrets
        // (untrusted context + a written key is lateral-movement fuel).
        const docTaskBlock = docTaskImEgressBlockReason(coords.channelId, OCTO_SECRET_TOOL_NAME);
        if (docTaskBlock) return errResult(docTaskBlock);

        const alias = (args.alias as string | undefined)?.trim();
        const filePath = (args.filePath as string | undefined)?.trim();
        if (!alias) return errResult("alias is required for write-secret");
        if (!filePath) return errResult("filePath is required for write-secret");
        const template = args.template as string | undefined;
        if (template !== undefined && !template.includes(SECRET_PLACEHOLDER)) {
          return errResult(`template must contain the ${SECRET_PLACEHOLDER} placeholder (or omit template to write the raw value)`);
        }
        const mode: "overwrite" | "append" = args.mode === "append" ? "append" : "overwrite";

        // Owner gate + audit. The write touches the owner's plaintext secret, so
        // a non-owner requester is refused before anything is fetched or written.
        if (!isOwner) {
          emitAuditLog({
            action: "secret:write-secret",
            requester: coords.requesterUid,
            target: alias,
            channelType: 0,
            result: "denied",
            reason: "owner-only secret write",
          });
          return errResult('action "write-secret" is limited to the bot owner');
        }
        emitAuditLog({
          action: "secret:write-secret",
          requester: coords.requesterUid,
          target: alias,
          channelType: 0,
          result: "allowed",
        });

        // Confine the destination BEFORE resolving the secret — if the path is
        // unsafe we never fetch the plaintext at all (minimize its lifetime).
        const jailRoot = config.secretsFileRoot?.trim() || coords.cwdDir;
        const confined = await confineSecretPath(filePath, jailRoot);
        if (!confined.ok) return errResult(confined.error);
        const absPath = confined.abs;
        const root = confined.root;

        let resolved;
        try {
          resolved = await resolveSecret({ apiUrl, botToken, alias, signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
        } catch (err) {
          // resolve failure (5xx / malformed / transport). The underlying error
          // carries only an HTTP status (the client drops bodies), never a value.
          return errResult(
            `Could not resolve secret "${alias}". The key service is unavailable or the secret may need to be re-set. Ask the user to re-add the key, then retry. (${err instanceof Error ? err.message : String(err)})`,
          );
        }

        if (resolved.status === "not_found") {
          return errResult(`No stored secret matches "${alias}". Ask the user to add this key first, then try again.`);
        }
        if (resolved.status === "rate_limited") {
          return errResult(`The key service is busy right now (rate limited). Wait a moment and retry write-secret for "${alias}".`);
        }
        if (resolved.status === "ambiguous") {
          // Hand back ONLY the labels (display_name + secret_id), never a value.
          return jsonResult({
            written: false,
            ambiguous: true,
            message: `Multiple stored secrets match "${alias}". Ask the user which one, then retry with the chosen display_name (or its secret_id).`,
            candidates: resolved.candidates,
          });
        }

        // resolved → substitute into template (or write raw). From here the
        // plaintext lives only in local variables and the file.
        const content = template ? template.split(SECRET_PLACEHOLDER).join(resolved.value) : resolved.value;

        try {
          const dir = dirname(absPath);
          let openTarget = absPath;
          if (dir && dir !== "." && dir !== absPath) {
            await mkdir(dir, { recursive: true });
            // 🔴 TOCTOU close-out for INTERMEDIATE components: O_NOFOLLOW below
            // only guards the leaf; the kernel still follows a symlink swapped
            // onto a parent AFTER mkdir. Re-canonicalize the parent now that it
            // exists, re-check containment, and open via the canonical parent +
            // basename so every component is proven inside the root.
            const realDir = await realpath(dir);
            if (!isInsideRoot(root, realDir)) {
              return errResult("Refusing to write the secret: the destination directory escaped the allowed root after creation.");
            }
            openTarget = resolvePath(realDir, basename(absPath));
          }
          // 🔴 TOCTOU close-out for the LEAF: open the final component with
          // O_NOFOLLOW so the kernel refuses to follow a symlink AT the target —
          // the write lands on the real in-jail file or fails (ELOOP), never on a
          // redirected target. O_CREAT applies 0o600 atomically on creation.
          const flags =
            (mode === "append"
              ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND
              : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC) |
            fsConstants.O_NOFOLLOW;
          const handle = await open(openTarget, flags, SECRET_FILE_MODE);
          try {
            await handle.write(content, null, "utf8");
            // `mode` only applies when CREATING; a pre-existing target keeps its
            // old perms. fchmod unconditionally so a plaintext key is always 0o600.
            await handle.chmod(SECRET_FILE_MODE);
          } finally {
            await handle.close();
          }
        } catch (err) {
          // A write error's MESSAGE can carry the absolute path (e.g. an fs error
          // "EACCES: permission denied, open '/abs/...'"), which would leak the
          // operator's jail root into the LLM-visible transcript. Surface ONLY the
          // error CODE (EACCES / ELOOP / ENOENT / …) — never err.message — so the
          // "never the absolute path" guarantee holds strictly. The jail-relative
          // path is still echoed for actionability.
          const code =
            err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
              ? (err as { code: string }).code
              : 'write failed';
          return errResult(
            `Resolved the secret but failed to write it to "${relative(root, absPath)}": ${code}`,
          );
        }

        // 🔴 Success payload is plaintext-free by construction (no value, no
        // rendered content, no byte length). The path is jail-relative so the
        // absolute jail root is never disclosed.
        return jsonResult({
          written: true,
          path: relative(root, absPath),
          mode,
          ...(resolved.display_name ? { display_name: resolved.display_name } : {}),
        });
      },
    ),
  ];
}

/** Build the octo_secret MCP server for one agent turn. */
export function createOctoSecretToolServer(
  config: OctoSecretToolConfig,
  coords: OctoSecretSessionCoords,
) {
  return createSdkMcpServer({
    name: OCTO_SECRET_TOOL_SERVER_NAME,
    version: "1.0.0",
    tools: buildOctoSecretTools(config, coords),
  });
}
