/**
 * card-skins registry + resolver unit tests, and per-skin progress-card render assertions
 * (all four skins render inside the octo/v1 whitelist + degrade safely).
 */
import { describe, it, expect } from "vitest";
import {
  SKINS, listSkins, isSkinId, parseSkinId, resolveSkin,
  DEFAULT_SKIN_ID, FALLBACK_SKIN_ID, type SkinId,
} from "../card-skins.js";
import { renderProgressCard, type CardProgressState } from "../card-render.js";

const ALL: SkinId[] = ["terminal", "dashboard", "editorial", "signal"];

const FULL_CAPS = {
  elements: new Set(["TextBlock", "RichTextBlock", "Container", "ColumnSet", "ActionSet"]),
  actions: new Set(["Action.ToggleVisibility"]),
};
const TEXT_ONLY = { elements: new Set(["TextBlock"]), inputs: new Set<string>(), actions: new Set<string>() };

const SAMPLE: CardProgressState = {
  phase: "done",
  elapsedMs: 12_400,
  steps: [
    { tool: "__thinking__", status: "done", durationMs: 3000 },
    { tool: "read", status: "done", summary: "/src/card-blocks.ts", durationMs: 120 },
    { tool: "read", status: "done", summary: "/src/card-render.ts", durationMs: 90 },
    { tool: "grep", status: "done", summary: "renderProgressCard", durationMs: 40 },
    { tool: "exec", status: "error", summary: "npm test", error: "exit 1" },
  ],
};

/** Recursively collect every string value under `text`/`title` keys, plus every `color`. */
function collectText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) return node.forEach((n) => collectText(n, out));
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.text === "string") out.push(o.text);
    for (const v of Object.values(o)) collectText(v, out);
  }
}
function allText(card: Record<string, unknown>): string {
  const out: string[] = [];
  collectText(card.body, out);
  return out.join("\n");
}

describe("card-skins registry", () => {
  it("exposes exactly the four owner-approved skins in a stable order", () => {
    expect(listSkins().map((s) => s.id)).toEqual(["terminal", "dashboard", "editorial", "signal"]);
    expect(Object.keys(SKINS).sort()).toEqual([...ALL].sort());
  });

  it("product default is editorial; back-compat fallback is dashboard", () => {
    expect(DEFAULT_SKIN_ID).toBe("editorial");
    expect(FALLBACK_SKIN_ID).toBe("dashboard");
  });

  it("isSkinId / parseSkinId accept ids, and parseSkinId accepts positional aliases", () => {
    for (const id of ALL) {
      expect(isSkinId(id)).toBe(true);
      expect(parseSkinId(id)).toBe(id);
      expect(parseSkinId(id.toUpperCase())).toBe(id);
    }
    expect(parseSkinId("skin3")).toBe("editorial");
    expect(parseSkinId("3")).toBe("editorial");
    expect(parseSkinId("1")).toBe("terminal");
    expect(parseSkinId("4")).toBe("signal");
    expect(parseSkinId("neon")).toBeNull();
    expect(parseSkinId("")).toBeNull();
  });

  it("resolveSkin falls back to dashboard for undefined/unknown, never throws", () => {
    expect(resolveSkin(undefined).id).toBe("dashboard");
    expect(resolveSkin("nope").id).toBe("dashboard");
    for (const id of ALL) expect(resolveSkin(id).id).toBe(id);
  });
});

describe("per-skin progress rendering (whitelist + degradation)", () => {
  it("every skin renders the agent_progress_v1 root shape under full caps", () => {
    for (const id of ALL) {
      const { card } = renderProgressCard(SAMPLE, FULL_CAPS, id);
      const body = card.body as Array<Record<string, unknown>>;
      expect(body.map((b) => b.type), id).toEqual(["ColumnSet", "Container"]);
      expect(card.metadata, id).toEqual({ octo_layout: "agent_progress_v1" });
      // Info is preserved across skins: the failing step's summary + code survive.
      const text = allText(card);
      expect(text, id).toContain("npm test");
      expect(text, id).toContain("exit 1");
    }
  });

  it("no skin emits a hex color, custom font, or separator (whitelist only)", () => {
    for (const id of ALL) {
      const { card } = renderProgressCard(SAMPLE, FULL_CAPS, id);
      const json = JSON.stringify(card);
      expect(json, id).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // no hex color
      expect(json, id).not.toContain('"fontFamily"');
      expect(json, id).not.toContain('"separator"');
      // Only whitelisted semantic colors ever appear.
      for (const m of json.matchAll(/"color":"([^"]+)"/g)) {
        expect(["good", "warning", "attention", "accent"], `${id} color ${m[1]}`).toContain(m[1]);
      }
    }
  });

  it("every skin degrades to TextBlock-only without losing info or emitting layout metadata", () => {
    for (const id of ALL) {
      const { card, plain } = renderProgressCard(SAMPLE, TEXT_ONLY, id);
      const body = card.body as Array<Record<string, unknown>>;
      expect(body.every((b) => b.type === "TextBlock"), id).toBe(true);
      expect(card.metadata, id).toBeUndefined();
      expect(plain, id).toContain("npm test");
    }
  });

  it("terminal skin uses monospace + ASCII glyphs; dashboard keeps emoji", () => {
    const term = renderProgressCard(SAMPLE, FULL_CAPS, "terminal").card;
    const termJson = JSON.stringify(term);
    expect(termJson).toContain('"fontType":"Monospace"');
    expect(termJson).toContain("[done]");          // terminal header tag
    expect(termJson).toContain("✗");               // ASCII error glyph
    expect(termJson).not.toContain("✅ Done");      // no emoji header in terminal

    const dash = renderProgressCard(SAMPLE, FULL_CAPS, "dashboard").card;
    expect(JSON.stringify(dash)).toContain("✅ Done"); // dashboard keeps the emoji header
  });

  it("signal skin carries state via traffic-light dots", () => {
    const { card } = renderProgressCard(SAMPLE, FULL_CAPS, "signal");
    const json = JSON.stringify(card);
    expect(json).toContain("🟢 Done"); // done header dot
    expect(json).toContain("🔴");       // error dot on the failed step
  });

  it("dashboard skin == the no-skin (back-compat) output byte-for-byte", () => {
    // The whole pre-skin test corpus relies on this equivalence.
    const withSkin = renderProgressCard(SAMPLE, FULL_CAPS, "dashboard");
    const noSkin = renderProgressCard(SAMPLE, FULL_CAPS);
    expect(withSkin).toEqual(noSkin);
  });

  it("editorial (product default) drops leading glyphs and GroupStyle tint", () => {
    const { card } = renderProgressCard(SAMPLE, FULL_CAPS, "editorial");
    const json = JSON.stringify(card);
    expect(json).toContain("Done");           // plain word header
    expect(json).not.toContain("✅ Done");     // no emoji
    // editorial sets keepGroupStyle=false → timeline phases carry no attention/warning tint.
    expect(json).not.toMatch(/"style":"(attention|warning)"/);
  });
});
