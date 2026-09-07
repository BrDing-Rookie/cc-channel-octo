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
