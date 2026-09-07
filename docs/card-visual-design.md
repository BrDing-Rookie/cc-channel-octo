# Card Visual Design Rationale

One page. Covers the three card families this project emits — the **progress card**
(`agent_progress_v1`), the **display card**, and the **interactive / send card** — and
maps each visual decision to the Adaptive Cards 1.5 attribute that expresses it and to the
hard constraints it must survive.

## Hard constraints (the sandbox every decision lives in)

Cards are **Adaptive Cards 1.5 JSON**, not HTML/CSS. The only expressive levers available are:

- **Semantic color**: `good` / `warning` / `attention` / `accent` / `emphasis` (the last only
  as a `Container` `GroupStyle`). No hex, no fonts.
- **Hierarchy**: `weight` (`Bolder`) and `size` (`Medium` / `Large`).
- **Rhythm**: `spacing` (`Small` / `Medium` / `Large`) between blocks.
- **Grouping**: `Container` with an optional `GroupStyle` tint.
- **Wrapping**: `wrap: true` always (IM is a narrow column; never truncate horizontally).

Three boundaries gate every attribute we emit (`card-blocks.ts` / `card-render.ts`):

1. **octo/v1 whitelist** — only end-to-end-verified elements/attributes. We add nothing outside
   `weight` / `size` / `spacing` / `wrap` / GroupStyle + the `good/warning/attention/accent`
   semantic colors, so no attribute can be rejected 400 by the server.
2. **CardCaps negotiated degradation** — every visual attribute rides on an element that already
   has a degradation path. When an element is not advertised, the attribute degrades **with** it
   (a `Container.spacing` vanishes when the group flattens to bare `TextBlock`s), never orphaned.
3. **Desensitization** — the reduction/secret pipeline is untouched. All visual work is on the
   *structure* around already-sanitized text; the `card-render.corpus` snapshots (LEAK / COST /
   PARITY / …) are unchanged, proving no visual change moved a byte through the redaction path.

The design intent is one coherent system across the three families: **`Large` masthead → `Medium`
section anchor → default body**, with color reserved for *meaning* (state or emphasis), not decoration.

## Progress card (`agent_progress_v1`)

Visual goal: at a glance, *what phase, how much work, what went wrong*.

- **KPI stat-strip** (dataviz stat-tile idea): the `Reasoning N · Tools N · Waiting N` summary now
  renders each **count** in `accent` + `Bolder` with the **label** kept `isSubtle`. The number is
  the datum; accent (a neutral emphasis color, not a state color) makes it pop in both light and
  dark themes. → `RichTextBlock` inlines with per-run `color`/`weight`/`isSubtle`.
  *Constraint*: the segments concatenate to a byte-identical `Reasoning 1 · Tools 1`; when
  `RichTextBlock` is not advertised it degrades to a single `isSubtle` `TextBlock` with the same
  text (verified by test). Data never depends on the emphasis.
- **Timeline phase separation**: each thinking→tool phase is a `Container`; `warning` (running) and
  `attention` (error) phases get `spacing: Medium` while settled `default` phases get `Small`, so
  the eye falls on the active/failed phase. → `Container.style` + `Container.spacing`.
  *Constraint*: when `Container` is not advertised the timeline flattens to plain rows (spacing and
  tint drop together, content intact).

## Display card

Visual goal: an IM-native first screen — one title, a compact summary, detail folded away.

- **Three-tier hierarchy**: title → `Bolder` + **`Large`** (card masthead); `heading` → `Bolder` +
  **`Medium`** (section anchor) with `spacing: Medium` above it; body `text` stays default size.
  Hierarchy no longer rests on bold alone. → `TextBlock.size` + `TextBlock.spacing`.
- **Callout rhythm**: styled `group` containers (`good/warning/attention/emphasis`) get
  `spacing: Medium`; neutral logical groups get `Small`. A semantic callout reads as emphasis, not
  background noise. → `Container.style` + `Container.spacing`.
  *Constraint*: without `Container` the group flattens to its children and our injected `spacing`
  is **not** stamped onto the bare `TextBlock`s (verified) — no visual residue, no 400.

## Interactive / send card

Visual goal: the decision question is unmistakable; options are scannable.

- **Shared hierarchy**: title → `Bolder` + **`Large`** (matches the display-card masthead); each
  `section` title → `Bolder` + **`Medium`**. A confirmation/approval card leads with its question at
  the top of the type scale. → `TextBlock.size`, consistent with the other two families.
  *Constraint*: buttons remain `Action.Submit` and gate on the `octo/v2` profile exactly as before;
  section bodies still wrap in a `Container` when advertised and flatten otherwise. Sizing is
  additive and does not touch the Submit / caps / secret-redaction contract.

## Why these levers and not more

`separator`, custom colors, and fonts were **not** used: they are either outside the verified
octo/v1 whitelist (400 risk) or carry no accessible light/dark guarantee. Every choice here is one
of the five verified attributes, each attached to an element that already degrades cleanly — so the
beautification is pure progressive enhancement over the existing, safe baseline.

---

# `/skins` — switchable card skins

The single visual language above is now one of **four owner-approved skins**, switchable at
runtime with the `/skins` in-chat command. A *skin* re-arranges the **same octo/v1 whitelist
bricks** into a different **skeleton / graphic language / density** — the three "free, high-impact"
axes. **No skin relaxes the three protocol edges** the owner chose to keep closed: **no hex, no
custom fonts, no separator/border**. So every skin degrades through CardCaps and desensitization
exactly like the baseline, and none can produce a server-400 structure. (`src/card-skins.ts` holds
the token bundles; `card-render.ts` reads them; `card-blocks.ts` / the display + interactive tools
read only the `density` hint.)

## The four skins (design intent → AC attributes)

| Skin | Skeleton / glyph / density | AC attributes it pulls |
|------|----------------------------|------------------------|
| **terminal** | monospace CLI-log · ASCII glyphs (`▶ ✓ ✗ ›`) · `[tag]` headers · compact | `fontType:"Monospace"` on every run · ASCII text glyphs · `spacing:Small` · no color except `attention` on errors |
| **dashboard** | emoji status · per-tool emoji · accent KPI counts · color-coded · cozy | emoji text · `color:"accent"` counts · `color:"good"/"attention"` · `GroupStyle` tint kept · `spacing:Medium` |
| **editorial** *(default)* | no leading glyphs · subtle bullets · restrained color · airy | plain-word headers · `isSubtle` · `spacing:Large` · GroupStyle tint dropped |
| **signal** | traffic-light dots (`🟢🟡🔴`) carry state · one badge per line · cozy | status dot text glyphs · minimal extra color · `spacing:Medium` |

Everything above is expressed only via `weight` / `size` / `spacing` / `wrap` / `isSubtle` /
`fontType:Monospace` / the semantic colors / `GroupStyle` + plain-text glyph systems. The glyph
system is the biggest differentiator and is **free** (emoji/ASCII/Unicode are just text).

**dashboard is special:** its token bundle reproduces the *pre-skin* renderer output byte-for-byte.
It is therefore the library **fallback** when no skin is passed (keeping the entire prior test
corpus valid), even though the **product default is `editorial`** (owner decision). The two are
deliberately separate: `FALLBACK_SKIN_ID = dashboard` (structural back-compat) vs
`DEFAULT_SKIN_ID = editorial` (what a live session renders with).

## What a skin does NOT change

- **Root shape** stays `[ColumnSet, Container#timeline_detail]` — the `agent_progress_v1` client
  contract. Skins vary *content treatment* (glyphs, density, header/summary, step-row style, phase
  tint) inside that stable envelope, never the skeleton the client parses.
- **Degradation**: on a TextBlock-only client every skin collapses to flat rows with the same
  information, no metadata, no color, no 400 (see `card-skins.test.ts` and the per-skin
  full-caps-vs-degraded proof images on the issue).
- **Desensitization**: unchanged — skins only touch structure/markers around already-sanitized
  text. The `card-render.corpus` LEAK/COST/PARITY snapshots are untouched.

## Usage & default

- `/skins` — list the four skins; the active one is marked `★`.
- `/skins <id>` — switch this session's active skin (`terminal` / `dashboard` / `editorial` /
  `signal`; the `skin3` / `3` positional aliases also work). Persisted per session in the
  `session_skins` table; **survives `/reset`** (a skin is a display preference, not history).
- **Default**: a session with no explicit choice uses the per-bot `sdk.defaultSkin`, else the
  product default **`editorial`**. Resolved once per turn in `index.ts` (session store → per-bot
  config → product default) and threaded into all three renderers. An unknown stored/config value
  degrades to the fallback rather than erroring.
