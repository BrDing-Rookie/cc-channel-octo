# Display Cards

Read this file before using `mcp__display_card__octo_send_display_card` or
changing automatic progress-card presentation.

## Contents

- [Use a display card for structured output](#use-a-display-card-for-structured-output)
- [Tool input](#tool-input)
- [Design rules](#design-rules)
- [Progress-card boundary](#progress-card-boundary)
- [Failure and fallback](#failure-and-fallback)

## Use a display card for structured output

Use `mcp__display_card__octo_send_display_card` for status reports, key-value
summaries, comparisons, tables, folded details, local copy buttons, and safe
navigation links. It produces octo/v1 content with **no bot callback**. `copy`,
`link`, and `collapsible` are client-local actions; they do not resume the agent.

Use plain text for short answers and normal conversation. Use
`mcp__send_card__octo_send_card`, not a display card, when a button must call back
to the bot.

## Tool input

Pass `{ title?, blocks[] }`. Author high-level blocks; never put raw Adaptive Card
elements in `blocks`. The delivery channel is runtime-owned — there is no target
argument.

| Block | Required fields | Intended use |
|---|---|---|
| `heading` | `text`; optional `size: medium\|large` | Short section heading |
| `text` | `text` | Body paragraph |
| `rich` | `segments[{text,bold?,subtle?,fontType?:'Monospace',color?:'good'\|'warning'\|'attention'\|'accent'}]` | Compact styled line |
| `facts` | `items[{label,value}]` | Key-value details |
| `columns` | `columns[{blocks[]}]` | Summary/KPI strip |
| `table` | `rows[{cells[]}]`; optional `columns[{width}]`, `firstRowAsHeader` | Dense matrix |
| `link` | `text`, `url` | Safe HTTP(S) navigation |
| `group` | `blocks[]`; optional `style` | Small semantic callout |
| `collapsible` | `summary`, `blocks[]`; optional `actionLabel`/`expandLabel`/`collapseLabel`/`defaultVisible` | Fold long details |
| `copy` | `text`; optional `label` | Local clipboard action |

Example:

```jsonc
{
  "title": "发布检查",
  "blocks": [
    {
      "type": "columns",
      "columns": [
        { "blocks": [{ "type": "heading", "text": "测试" }, { "type": "text", "text": "通过" }] },
        { "blocks": [{ "type": "heading", "text": "风险" }, { "type": "text", "text": "低" }] }
      ]
    },
    {
      "type": "facts",
      "items": [
        { "label": "版本", "value": "v1.2.3" },
        { "label": "环境", "value": "staging" }
      ]
    },
    {
      "type": "collapsible",
      "summary": "详情",
      "expandLabel": "展开详情",
      "collapseLabel": "收起详情",
      "blocks": [{ "type": "text", "text": "所有必需检查均已完成。" }]
    }
  ]
}
```

The tool probes octo/v1 capabilities, degrades unsupported block types to safe
text where possible, derives a truthful `plain` fallback, applies recursive
payload limits, and removes secret-shaped content. Unknown block types or missing
fields are silently dropped. Do not probe the profile yourself when using the
tool.

## Design rules

- Keep exactly one title and a compact first screen, normally 3–6 lines.
- Use `columns` for a small top summary and `facts` for detail fields.
- Put long process details or evidence in one `collapsible` block. Summarize
  reasoning stages; do not paste raw tool events, stack traces, long paths, or
  logs.
- Do not pre-truncate content or add your own "省略 N 项" / "超出限制" notices. Pass
  the full set of high-level blocks; the tool enforces `max_nodes` / `max_depth` /
  `max_payload_bytes` recursively and degrades or drops to fit. If the content
  genuinely cannot fit as a card, reply in plain text.
- Use no `group.style` for ordinary information. Use `emphasis` for a small
  neutral callout and `good`, `warning`, or `attention` only for a real status.
  Prefer highlighting key tokens with `rich` segment colors over recoloring whole
  lines.
- Use `copy` only for local clipboard content. It is not a confirmation button.
- Keep URLs and all visible/fallback text non-sensitive. Hidden and copied content
  is still stored in the group-visible card JSON.
- After the tool returns, send a one-line text result so the turn does not end on
  a side effect.

## Progress-card boundary

When the operator enables `sdk.progressCard`, cc keeps one live display card per
turn showing a thinking/tool/answering/done state machine, edited in place. These
automatic progress cards are display-only octo/v1 cards managed by the gateway
lifecycle — do not replace them with `mcp__send_card__octo_send_card` or wait for
callbacks from them. (`sdk.showReasoning` additionally captures reasoning text
onto the card after 4-state classification + desensitization.)

## Failure and fallback

If `mcp__display_card__octo_send_display_card` is absent, disabled, the profile
probe fails, or no safe card fits the negotiated limits, send the answer as plain
text. Unlike the submit-card path, a display-tool error does not itself send a
fallback message — you must write the text.

The tool always derives the current Octo account/channel/thread from runtime
context and sends as the bot. Do not add target or persona fields to the
arguments.
