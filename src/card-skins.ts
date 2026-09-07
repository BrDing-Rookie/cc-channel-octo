/**
 * Card SKINS — runtime-switchable visual styles for the agent progress card (and a density
 * hint the display / interactive builders honor). Selected in-chat via `/skins`; the active
 * skin is resolved per session in index.ts and threaded into the renderers.
 *
 * This module is PURE TOKEN DATA — no imports from card-render / card-blocks — so it cannot
 * create an import cycle and is trivially unit-testable. card-render.ts owns the segment-building
 * functions and reads these tokens; card-blocks / card-* read only the `density` hint.
 *
 * ── Hard constraints (unchanged) ────────────────────────────────────────────
 * Every token below resolves to an octo/v1-whitelist attribute only: emoji / ASCII / Unicode
 * are plain TEXT (free), `mono` maps to `fontType:"Monospace"`, colors are the semantic set
 * (good / warning / attention / accent), density maps to `spacing` (Small/Medium/Large). NO hex,
 * NO custom fonts, NO separator lines, NO border radius — the three protocol edges the owner
 * chose NOT to relax. A skin only re-arranges the SAME safe bricks, so CardCaps degradation and
 * desensitization are untouched and no skin can produce a server-400 structure.
 *
 * ── The four skins (owner-approved) ─────────────────────────────────────────
 *   dashboard  emoji status · per-tool emoji · accent KPI counts · good/attention color · cozy
 *              (this token set REPRODUCES the pre-skin output byte-for-byte — it is the library
 *               back-compat fallback when no skin is passed; see resolveProgressSkin(undefined))
 *   terminal   monospace everywhere · ASCII glyph set (▶ ✓ ✗ ›) · minimal color · compact
 *   editorial  no leading glyphs · subtle bullets · minimal color · airy  (PRODUCT DEFAULT)
 *   signal     traffic-light dots (🟢🟡🔴) carry state · color minimal · cozy
 */

import type { RichSegment } from "./card-blocks.js";

export type SkinId = "terminal" | "dashboard" | "editorial" | "signal";

/** Product default active skin (owner decision: skin3 = EDITORIAL). */
export const DEFAULT_SKIN_ID: SkinId = "editorial";

/**
 * Library back-compat fallback used when NO skin is passed to the renderer (e.g. the existing
 * test suite calls `renderProgressCard(state, caps)` with no third arg). It is DASHBOARD because
 * DASHBOARD's tokens reproduce the exact pre-skin output — keeping every pinned assertion valid.
 * This is deliberately DIFFERENT from DEFAULT_SKIN_ID: the product default (what a live session
 * renders with) is EDITORIAL, resolved at the store/config layer; the structural fallback (what
 * the pure renderer emits absent any selection) is DASHBOARD.
 */
export const FALLBACK_SKIN_ID: SkinId = "dashboard";

type RichColor = NonNullable<RichSegment["color"]>;
type Spacing = "Small" | "Medium" | "Large";

/** How a step's leading tool icon is produced. */
export type ToolIconMode =
  | "emoji"    // per-tool emoji from resolveToolMeta (dashboard)
  | "ascii"    // fixed ASCII marker (terminal)
  | "dot"      // traffic-light dot chosen by status (signal)
  | "hidden";  // no leading icon; a subtle bullet carries the row (editorial)

export interface ProgressSkinTokens {
  /** Leading marker for each terminal/透 header phrase. Assembly (counts/duration) is shared. */
  header: {
    done: string;        // "✅ Done"
    working: string;     // "🤖 Working…"
    thinking: string;    // "🤖 Thinking…"
    paused: string;      // "⏸️ Waiting for results"
    resuming: string;    // "🤖 Preparing results"
    answering: string;   // "🤖 Answering"
    expired: string;     // "⏱️ Wait timed out"
    stopped: string;     // "⚠️ Stopped"
    interrupted: string; // "⚠️ Interrupted"
  };
  /** Step-row glyphs. */
  running: string;       // running step marker ("⏳")
  errorGlyph: string;    // error step marker ("❌")
  reasoning: string;     // __thinking__ icon ("💭")
  waiting: string;       // __subagent_wait__ icon ("⏸️")
  /** Per-tool icon strategy for normal (done) steps. */
  toolIconMode: ToolIconMode;
  /** ASCII markers when toolIconMode==="ascii". `_` is the default for unlisted tools. */
  ascii: { ok: string; run: string; err: string; reason: string; wait: string; tool: string };
  /** Dots when toolIconMode==="dot". */
  dot: { ok: string; warn: string; err: string; neutral: string };
  /** Bullet used when toolIconMode==="hidden" (editorial). Empty string = truly no marker. */
  bullet: string;
  /** Wrap step summaries (and, in terminal, the whole row) in Monospace. */
  mono: boolean;
  /** Render the tool label subtle (true today). */
  labelSubtle: boolean;
  /** Inline separator between label and duration (" · " today). */
  sep: string;
  /** Colors; null = no color (subtle/plain only). */
  durationColor: RichColor | null;   // "good" today
  errorColor: RichColor | null;      // "attention" today
  countColor: RichColor | null;      // "accent" today (KPI counts)
  /** Timeline Container spacing: styled = warning/attention phase, plain = default phase. */
  groupSpacingStyled: Spacing;       // "Medium" today
  groupSpacingPlain: Spacing;        // "Small" today
  /** Whether timeline phases keep their GroupStyle tint (dashboard) or go neutral (editorial). */
  keepGroupStyle: boolean;
  /** Section spacing hint for display / interactive builders. */
  density: Spacing;
}

export interface Skin {
  id: SkinId;
  label: string;
  /** One-line orientation shown by `/skins`. */
  blurb: string;
  progress: ProgressSkinTokens;
}

// ── DASHBOARD — reproduces the pre-skin output exactly (back-compat fallback) ──
const DASHBOARD: Skin = {
  id: "dashboard",
  label: "Dashboard",
  blurb: "emoji status · per-tool icons · accent metrics · color-coded · cozy",
  progress: {
    header: {
      done: "✅ Done", working: "🤖 Working…", thinking: "🤖 Thinking…",
      paused: "⏸️ Waiting for results", resuming: "🤖 Preparing results",
      answering: "🤖 Answering", expired: "⏱️ Wait timed out",
      stopped: "⚠️ Stopped", interrupted: "⚠️ Interrupted",
    },
    running: "⏳", errorGlyph: "❌", reasoning: "💭", waiting: "⏸️",
    toolIconMode: "emoji",
    ascii: { ok: "✓", run: "▶", err: "✗", reason: "›", wait: "⏸", tool: "·" },
    dot: { ok: "🟢", warn: "🟡", err: "🔴", neutral: "⚪" },
    bullet: "",
    mono: false, labelSubtle: true, sep: " · ",
    durationColor: "good", errorColor: "attention", countColor: "accent",
    groupSpacingStyled: "Medium", groupSpacingPlain: "Small", keepGroupStyle: true,
    density: "Medium",
  },
};

// ── TERMINAL — monospace CLI-log, ASCII glyphs, minimal color, compact ──
const TERMINAL: Skin = {
  id: "terminal",
  label: "Terminal",
  blurb: "monospace CLI-log · ASCII glyphs (▶ ✓ ✗ ›) · minimal color · compact",
  progress: {
    header: {
      done: "[done]", working: "[run]", thinking: "[think]",
      paused: "[wait]", resuming: "[prep]", answering: "[answer]",
      expired: "[timeout]", stopped: "[stopped]", interrupted: "[error]",
    },
    running: "▶", errorGlyph: "✗", reasoning: "›", waiting: "⏸",
    toolIconMode: "ascii",
    ascii: { ok: "✓", run: "▶", err: "✗", reason: "›", wait: "⏸", tool: "·" },
    dot: { ok: "🟢", warn: "🟡", err: "🔴", neutral: "⚪" },
    bullet: "",
    mono: true, labelSubtle: false, sep: "  ·  ",
    durationColor: null, errorColor: "attention", countColor: null,
    groupSpacingStyled: "Small", groupSpacingPlain: "Small", keepGroupStyle: false,
    density: "Small",
  },
};

// ── EDITORIAL — no glyphs, subtle bullets, minimal color, airy (PRODUCT DEFAULT) ──
const EDITORIAL: Skin = {
  id: "editorial",
  label: "Editorial",
  blurb: "no leading glyphs · subtle bullets · restrained color · airy (default)",
  progress: {
    header: {
      done: "Done", working: "Working", thinking: "Thinking",
      paused: "Waiting for results", resuming: "Preparing results",
      answering: "Answering", expired: "Wait timed out",
      stopped: "Stopped", interrupted: "Interrupted",
    },
    running: "·", errorGlyph: "·", reasoning: "·", waiting: "·",
    toolIconMode: "hidden",
    ascii: { ok: "·", run: "·", err: "·", reason: "·", wait: "·", tool: "·" },
    dot: { ok: "🟢", warn: "🟡", err: "🔴", neutral: "⚪" },
    bullet: "·",
    mono: false, labelSubtle: true, sep: " · ",
    durationColor: null, errorColor: "attention", countColor: null,
    groupSpacingStyled: "Large", groupSpacingPlain: "Large", keepGroupStyle: false,
    density: "Large",
  },
};

// ── SIGNAL — traffic-light dots carry state, minimal extra color, cozy ──
const SIGNAL: Skin = {
  id: "signal",
  label: "Signal",
  blurb: "traffic-light dots (🟢🟡🔴) carry state · one badge per line · cozy",
  progress: {
    header: {
      done: "🟢 Done", working: "🟡 Working…", thinking: "🟡 Thinking…",
      paused: "🟡 Waiting for results", resuming: "🟡 Preparing results",
      answering: "🟡 Answering", expired: "🔴 Wait timed out",
      stopped: "🔴 Stopped", interrupted: "🔴 Interrupted",
    },
    running: "🟡", errorGlyph: "🔴", reasoning: "🟢", waiting: "🟡",
    toolIconMode: "dot",
    ascii: { ok: "✓", run: "▶", err: "✗", reason: "›", wait: "⏸", tool: "·" },
    dot: { ok: "🟢", warn: "🟡", err: "🔴", neutral: "⚪" },
    bullet: "",
    mono: false, labelSubtle: true, sep: " · ",
    durationColor: null, errorColor: "attention", countColor: null,
    groupSpacingStyled: "Medium", groupSpacingPlain: "Small", keepGroupStyle: false,
    density: "Medium",
  },
};

/** Registry, insertion order = display order in `/skins`. */
export const SKINS: Record<SkinId, Skin> = {
  terminal: TERMINAL,
  dashboard: DASHBOARD,
  editorial: EDITORIAL,
  signal: SIGNAL,
};

/** All skins in a stable order for listing. */
export function listSkins(): Skin[] {
  return [TERMINAL, DASHBOARD, EDITORIAL, SIGNAL];
}

/** True when `s` is a known skin id (case-insensitive callers should lowercase first). */
export function isSkinId(s: string): s is SkinId {
  return s === "terminal" || s === "dashboard" || s === "editorial" || s === "signal";
}

/**
 * Normalize free user text to a SkinId, or null. Accepts the id, the label (case-insensitive),
 * and the `skin3`/`3` positional aliases owner used in discussion (1=terminal … 4=signal).
 */
export function parseSkinId(raw: string): SkinId | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (isSkinId(s)) return s;
  const byPosition: Record<string, SkinId> = {
    "1": "terminal", skin1: "terminal",
    "2": "dashboard", skin2: "dashboard",
    "3": "editorial", skin3: "editorial",
    "4": "signal", skin4: "signal",
  };
  return byPosition[s] ?? null;
}

/**
 * Resolve a skin id (or undefined) to its token bundle. `undefined` → FALLBACK (dashboard), which
 * reproduces the pre-skin renderer output. An unknown string also falls back rather than throwing,
 * so a stale stored value can never break rendering.
 */
export function resolveSkin(id: SkinId | string | undefined): Skin {
  if (id && isSkinId(id)) return SKINS[id];
  return SKINS[FALLBACK_SKIN_ID];
}
