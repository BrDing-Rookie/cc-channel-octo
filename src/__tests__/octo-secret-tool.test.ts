/**
 * B10 write-secret tests: FS-jail confinement (`..` / absolute-escape / symlink
 * escape / dangling symlink), owner gate + audit, resolve-status handling,
 * template substitution, 0o600 mode, and plaintext containment (the resolved
 * value never appears in the tool result).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string }) => ({ type: "sdk", name: opts.name, instance: {} }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

const api = vi.hoisted(() => ({ resolveSecret: vi.fn() }));
vi.mock("../octo/api.js", () => api);

const auditLines: Array<Record<string, unknown>> = [];
vi.mock("../audit.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../audit.js");
  return { ...actual, emitAuditLog: (e: Record<string, unknown>) => auditLines.push(e) };
});

import {
  buildOctoSecretTools,
  OCTO_SECRET_TOOL_NAME,
  type OctoSecretSessionCoords,
  type OctoSecretToolConfig,
} from "../octo-secret-tool.js";

const SECRET = "sk-PLAINTEXT-DO-NOT-LEAK-12345";
const CONFIG: OctoSecretToolConfig = { apiUrl: "https://x.example.com", botToken: "bf_t" };

let jail: string;
let outside: string;

function coords(over?: Partial<OctoSecretSessionCoords>): OctoSecretSessionCoords {
  return { channelId: "g1", requesterUid: "own", ownerUid: "own", cwdDir: jail, ...over };
}

async function invoke(args: Record<string, unknown>, c: OctoSecretSessionCoords = coords()) {
  const tools = buildOctoSecretTools(CONFIG, c);
  const t = tools.find((x) => (x as { name: string }).name === OCTO_SECRET_TOOL_NAME) as unknown as {
    handler: (a: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  };
  return t.handler(args, {});
}
const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text);
const text = (res: { content: Array<{ text: string }> }) => res.content[0].text;

beforeEach(() => {
  api.resolveSecret.mockReset();
  api.resolveSecret.mockResolvedValue({ status: "resolved", value: SECRET, display_name: "OpenAI" });
  auditLines.length = 0;
  jail = mkdtempSync(join(tmpdir(), "secret-jail-"));
  outside = mkdtempSync(join(tmpdir(), "secret-outside-"));
});
afterEach(() => {
  rmSync(jail, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("owner gate", () => {
  it("denies a non-owner (never resolves, audits denied)", async () => {
    const res = await invoke({ alias: "OpenAI", filePath: "key.env" }, coords({ requesterUid: "u1" }));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/limited to the bot owner/);
    expect(api.resolveSecret).not.toHaveBeenCalled();
    expect(auditLines.some((l) => l.action === "secret:write-secret" && l.result === "denied")).toBe(true);
  });

  it("audits an allowed owner write", async () => {
    await invoke({ alias: "OpenAI", filePath: "key.env" });
    expect(auditLines.some((l) => l.action === "secret:write-secret" && l.result === "allowed")).toBe(true);
  });
});

describe("happy path", () => {
  it("writes the raw value, returns a jail-relative path, mode 0o600, no plaintext in result", async () => {
    const res = await invoke({ alias: "OpenAI", filePath: "sub/key.env" });
    const out = parse(res);
    expect(out.written).toBe(true);
    expect(out.path).toBe(join("sub", "key.env"));
    expect(out.display_name).toBe("OpenAI");
    // result must NOT contain the plaintext
    expect(text(res)).not.toContain(SECRET);
    // file content + mode
    const abs = join(jail, "sub", "key.env");
    expect(readFileSync(abs, "utf8")).toBe(SECRET);
    expect(statSync(abs).mode & 0o777).toBe(0o600);
  });

  it("substitutes the {{secret}} template", async () => {
    await invoke({ alias: "OpenAI", filePath: "k.env", template: "OPENAI_API_KEY={{secret}}\n" });
    expect(readFileSync(join(jail, "k.env"), "utf8")).toBe(`OPENAI_API_KEY=${SECRET}\n`);
  });

  it("rejects a template without the placeholder (before resolving)", async () => {
    const res = await invoke({ alias: "OpenAI", filePath: "k.env", template: "no placeholder here" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/\{\{secret\}\}/);
    expect(api.resolveSecret).not.toHaveBeenCalled();
  });

  it("append mode adds to an existing file", async () => {
    writeFileSync(join(jail, "k.env"), "FIRST\n");
    await invoke({ alias: "OpenAI", filePath: "k.env", mode: "append", template: "SECOND={{secret}}" });
    expect(readFileSync(join(jail, "k.env"), "utf8")).toBe(`FIRST\nSECOND=${SECRET}`);
  });
});

describe("resolve-status handling (no plaintext leaks)", () => {
  it("not_found → actionable error, nothing written", async () => {
    api.resolveSecret.mockResolvedValue({ status: "not_found" });
    const res = await invoke({ alias: "Nope", filePath: "k.env" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/No stored secret matches/);
  });

  it("rate_limited → transient hint", async () => {
    api.resolveSecret.mockResolvedValue({ status: "rate_limited" });
    const res = await invoke({ alias: "OpenAI", filePath: "k.env" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/rate limited/i);
  });

  it("ambiguous → returns candidate labels only, nothing written", async () => {
    api.resolveSecret.mockResolvedValue({
      status: "ambiguous",
      candidates: [{ display_name: "OpenAI Prod", secret_id: "s1" }, { display_name: "OpenAI Dev", secret_id: "s2" }],
    });
    const out = parse(await invoke({ alias: "OpenAI", filePath: "k.env" }));
    expect(out.written).toBe(false);
    expect(out.ambiguous).toBe(true);
    expect(out.candidates).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("resolve throw → error carries no plaintext", async () => {
    api.resolveSecret.mockRejectedValue(new Error("resolveSecret failed (503)"));
    const res = await invoke({ alias: "OpenAI", filePath: "k.env" });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toContain(SECRET);
  });
});

describe("FS jail (the security core)", () => {
  it("rejects `..` traversal and never resolves the secret", async () => {
    const res = await invoke({ alias: "OpenAI", filePath: "../escape.env" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/outside the (allowed|permitted)/i);
    expect(api.resolveSecret).not.toHaveBeenCalled();
  });

  it("rejects an absolute path pointing outside the jail", async () => {
    const res = await invoke({ alias: "OpenAI", filePath: join(outside, "loot.env") });
    expect(res.isError).toBe(true);
    expect(api.resolveSecret).not.toHaveBeenCalled();
  });

  it("rejects a path that escapes through an intermediate symlink", async () => {
    symlinkSync(outside, join(jail, "link"));
    const res = await invoke({ alias: "OpenAI", filePath: "link/loot.env" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/symlink that escapes/);
    expect(api.resolveSecret).not.toHaveBeenCalled();
  });

  it("rejects a leaf symlink pointing outside the jail", async () => {
    symlinkSync(join(outside, "target.env"), join(jail, "leaf"));
    const res = await invoke({ alias: "OpenAI", filePath: "leaf" });
    expect(res.isError).toBe(true);
    // dangling (target does not exist) → "cannot be verified"; existing → "escapes"
    expect(text(res)).toMatch(/symlink/);
    expect(api.resolveSecret).not.toHaveBeenCalled();
  });

  it("rejects a dangling symlink unconditionally", async () => {
    symlinkSync(join(outside, "does-not-exist"), join(jail, "dangle"));
    const res = await invoke({ alias: "OpenAI", filePath: "dangle" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/cannot be verified/);
  });

  it("allows a path through an intermediate symlink that stays INSIDE the jail", async () => {
    mkdirSync(join(jail, "real"));
    symlinkSync(join(jail, "real"), join(jail, "alias-dir"));
    const res = await invoke({ alias: "OpenAI", filePath: "alias-dir/k.env" });
    expect(res.isError).toBeUndefined();
    // written through the in-jail symlink to the real dir
    expect(readFileSync(join(jail, "real", "k.env"), "utf8")).toBe(SECRET);
  });

  it("refuses when the jail root is the filesystem root", async () => {
    const res = await invoke({ alias: "OpenAI", filePath: "k.env" }, coords({ cwdDir: "/" }));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/filesystem root/);
    expect(api.resolveSecret).not.toHaveBeenCalled();
  });

  it("an explicit secretsFileRoot wins over the session cwd", async () => {
    const alt = mkdtempSync(join(tmpdir(), "secret-alt-"));
    try {
      const tools = buildOctoSecretTools({ ...CONFIG, secretsFileRoot: alt }, coords());
      const t = tools[0] as unknown as { handler: (a: Record<string, unknown>, e: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };
      const out = parse(await t.handler({ alias: "OpenAI", filePath: "k.env" }, {}));
      expect(out.written).toBe(true);
      expect(readFileSync(join(alt, "k.env"), "utf8")).toBe(SECRET);
    } finally {
      rmSync(alt, { recursive: true, force: true });
    }
  });
});

describe("doc-task egress guard", () => {
  it("blocks write-secret in a doc-task session (never resolves)", async () => {
    const res = await invoke({ alias: "OpenAI", filePath: "k.env" }, coords({ channelId: "doctask:doc1:thread1" }));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/document-comment task/);
    expect(api.resolveSecret).not.toHaveBeenCalled();
  });
});
