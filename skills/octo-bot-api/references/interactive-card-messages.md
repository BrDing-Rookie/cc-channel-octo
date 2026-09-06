# Card Message Guidance Moved

Card guidance lives in the progressive `$octo-card-message` skill so an agent
loads only the relevant path:

- `../../octo-card-message/references/interactive-submit.md` for
  `mcp__send_card__octo_send_card`, submit buttons, forms, and callback turns.
- `../../octo-card-message/references/display-card.md` for
  `mcp__display_card__octo_send_display_card` and progress-card presentation.
- `../../octo-card-message/references/raw-api.md` for hand-written type-17 HTTP
  clients (rarely needed in cc — the tools do this for you).

Use `$octo-card-message` before card work. This compatibility file intentionally
does not duplicate the protocol, schemas, and security rules.
