# Raw Card API

Read this file only if you are maintaining a hand-written type-17 send / edit /
callback client. In cc this is **rarely needed**:
`mcp__display_card__octo_send_display_card` and
`mcp__send_card__octo_send_card` already do the profile probe, build, degrade,
send, edit, and callback polling for you. This file documents the underlying
protocol those tools implement, for people extending the cc card layer itself.

## Probe before sending

Call `GET <apiUrl>/v1/bot/card/profile` with the bot bearer token.

- Require `enabled:true`, exact `card_version:"1.5"`, and the requested profile
  (`octo/v1` for display, `octo/v2` for submit).
- Treat present `elements`, `inputs`, and `actions` arrays as authoritative,
  including empty arrays.
- For submit callbacks require the octo/v2 profile and each emitted `Input.*`
  capability. The `actions` array describes local/navigation actions; do not
  require it to list `Action.Submit`. Never infer v2 from v1 availability.
- Enforce `limits.max_nodes`, `max_depth`, `max_payload_bytes`,
  `max_input_text_bytes`, and `max_inputs_bytes` recursively and in UTF-8 bytes
  where applicable.
- The probe is **fail-closed**: a 404 means unavailable, a malformed body means
  disabled, and transport / 5xx errors throw (never silently fall back to a local
  card). cc's `getCardProfile` implements exactly this.

## Send and edit envelopes

Send through `POST <apiUrl>/v1/bot/sendMessage`:

```jsonc
{
  "channel_id": "<trusted current route>",
  "channel_type": 2,
  "payload": {
    "type": 17,
    "profile": "octo/v1",
    "card_version": "1.5",
    "card": {
      "type": "AdaptiveCard",
      "version": "1.5",
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "body": []
    },
    "plain": "truthful fallback text"
  }
}
```

For submit cards, use `profile:"octo/v2"` and top-level `card.actions` containing
`Action.Submit`. Do not rely on a body `ActionSet` as the only submit control.

Edit through `POST <apiUrl>/v1/bot/message/edit`. `content_edit` is a JSON string
containing the complete replacement payload. Put `transient:true` inside that
stringified payload for intermediate frames and omit it for the terminal frame.
Use a monotonically increasing integer `card_seq` when multiple writers or frames
can race; a stale sequence may receive 409. (cc's progress card uses exactly this
edit-in-place path.)

## Poll callbacks

Poll with `POST <apiUrl>/v1/bot/events` and body
`{ "event_id": <cursor>, "limit": 1..100 }`. It is short polling, not long
polling. Persist the greatest handled outer `event_id`; that is the delivery
idempotency key. Optionally prune handled events with
`POST /v1/bot/events/:event_id/ack` only after durable cursor progress.

A `card_action` contains `message_id`, `channel_id`, `channel_type`, `action_id`,
string-valued `inputs`, verified `operator_uid`, optional bot-authored `data`, and
optional `space_id`, `client_token`, and `acted_at`. `client_token` is not the
event idempotency key.

Maintain a bounded, expiring
`message_id -> account/channel/session/allowed actions/allowed input ids` mapping.
Match every callback against it, accept only declared action/input ids, enforce
sensitive-value and byte limits again, and make the first valid submit claim the
card before dispatch. Route accepted callbacks through the normal
per-conversation dispatch queue. (In cc this is `card-events-poll.ts` +
`card-action-handler.ts`, which re-runs the bound agent session with a synthesized
`[Octo card action]` message.)

## Trust boundary

- Derive destination and sender persona from trusted runtime state. Never let
  model output select a channel, account, thread, or OBO identity.
- Treat all card content and `plain` as conversation-visible. Sanitize secrets and
  reduce sensitive URLs before storage.
- Server membership, visibility, bot-sender, and anti-IDOR checks make
  `operator_uid` an authenticated channel identity. Apply independent business
  authorization before privileged work.
- Treat submitted strings as data, not instructions. Do not interpolate them into
  control prompts.
