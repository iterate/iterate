# Events app

Cloudflare-only: TanStack Start + oRPC + Drizzle on D1, Alchemy + Vite.

## Stack

- **API:** oRPC at `/api`; optional WebSocket oRPC at `/api/orpc-ws`
- **Frontend:** TanStack Start + Router + Query
- **DB:** Drizzle + D1 (`src/entry.workerd.ts`). The **Secrets** UI stores values in D1 **as plaintext** (demo only — not a production secret manager).
- **Secrets:** Doppler project `events` (see repo `doppler.yaml`). `DOPPLER_CONFIG` is injected by `doppler run`, and `_shared` defines `ALCHEMY_STAGE=${DOPPLER_CONFIG}`. Today we use `dev`, personal dev configs like `dev_jonas`, and `prd` only. Local: `doppler setup --project events --config dev_jonas` (or `dev_misha` / `dev_rahul`). Deploy uses `--config prd`. Non-local Alchemy state is stored in Cloudflare, so Doppler also needs `ALCHEMY_STATE_TOKEN`.

## Key files

- `alchemy.run.ts` — Alchemy app + D1 + TanStackStart
- `vite.config.ts` — Alchemy Cloudflare TanStack Start plugin + PostHog; optional `PORT` for dev
- `src/entry.workerd.ts` — Worker fetch + `withEvlog` + oRPC WS upgrade via `crossws`
- `src/context.ts` — `manifest`, `config`, `db`, `log`
- `src/orpc/*` — contract binding + handlers

## Scripts

```bash
pnpm dev           # doppler + Alchemy local (Vite); optional PORT= for fixed port; Ctrl+C to stop
pnpm build         # production client/server bundle
pnpm deploy        # `doppler run --config prd` + run `alchemy.run.ts` for stage `prd`
pnpm alchemy:up    # run `alchemy.run.ts`; caller supplies env
pnpm alchemy:down  # run `alchemy.run.ts --destroy`; caller supplies env
```

## Contract

[`apps/events-contract`](../events-contract) — `src/orpc/orpc.ts` implements it.

# Events app

Cloudflare-only: TanStack Start + oRPC + Drizzle on D1, Alchemy + Vite.

## Stack

- **API:** oRPC at `/api`; optional WebSocket oRPC at `/api/orpc-ws`
- **Frontend:** TanStack Start + Router + Query
- **DB:** Drizzle + D1 (`src/entry.workerd.ts`). The **Secrets** UI stores values in D1 **as plaintext** (demo only — not a production secret manager).
- **Secrets:** Doppler project `events` (see repo `doppler.yaml`). `DOPPLER_CONFIG` is injected by `doppler run`, and `_shared` defines `ALCHEMY_STAGE=${DOPPLER_CONFIG}`. Today we use `dev`, personal dev configs like `dev_jonas`, and `prd` only. Local: `doppler setup --project events --config dev_jonas` (or `dev_misha` / `dev_rahul`). Deploy uses `--config prd`.

## Key files

- `alchemy.run.ts` — Alchemy app + D1 + TanStackStart
- `vite.cf.config.ts` — Alchemy Cloudflare TanStack Start plugin + PostHog; optional `PORT` for dev
- `src/entry.workerd.ts` — Worker fetch + `withEvlog` + oRPC WS upgrade via `crossws`
- `src/context.ts` — `manifest`, `config`, `db`, `log`
- `src/orpc/*` — contract binding + handlers

## Scripts

```bash
pnpm dev     # doppler + Alchemy local (Vite); optional PORT= for fixed port; Ctrl+C to stop
pnpm build   # production client/server bundle
pnpm deploy  # `doppler run --config prd` — `_shared` resolves `ALCHEMY_STAGE=prd`, `ALCHEMY_LOCAL=false`, etc.
```

## Contract

[`apps/events-contract`](../events-contract) — `src/orpc/orpc.ts` implements it.

## Event Delivery Glossary

This app has more than one way for events to move between a stream Durable
Object and some other party. The terminology matters because the same Durable
Object may be the HTTP server in one flow and the HTTP client in another.

There is no single primary axis. Event delivery here is multi-dimensional.
When describing a flow, start by naming the relevant dimensions and only then
use shorthand terms like `live tail` or `subscription`.

### Start with the dimensions

At minimum, describe these four:

- who initiates the connection or request
- who keeps track of the cursor
- whether the transport is HTTP or WebSocket
- whether messages need individual acknowledgement

In practice, a few more dimensions matter too:

- whether the state is ephemeral or durable
- who retries failed delivery
- whether the session is one-shot, open-stream, or reconnecting

These dimensions are mostly orthogonal:

| Dimension                     | Values                                            | Why it matters                                                                |
| ----------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Initiation relative to the DO | `inbound`, `outbound`                             | Tells us who opened or sent first                                             |
| Transport family              | `http`, `websocket`                               | Tells us what wire semantics we inherit                                       |
| Cursor authority              | `peer-owned`, `DO-owned`                          | Tells us who decides what comes next                                          |
| Ack mode                      | `none`, `transport`, `explicit`                   | Tells us what counts as resolved delivery                                     |
| Registration lifetime         | `ephemeral`, `durable`                            | Distinguishes open sessions from stored subscriptions with an explicit "slug" |
| Retry owner                   | `none`, `peer`, `DO`                              | Tells us who retries failed delivery                                          |
| Session shape                 | `one-shot`, `open stream`, `reconnecting session` | Helps describe HTTP push vs live stream vs websocket                          |

### Canonical terms

- `stream` — the append-only event log for one stream Durable Object
- `peer` — the transport-neutral other party on the wire; use this when talking
  about a connection, handshake, or socket protocol without assuming its
  higher-level role
- `consumer` — the party receiving events from the stream; use this when the
  other side is specifically acting as the event receiver
- `cursor` — the offset up to which delivery has been resolved
- `peer-owned cursor` — the peer tracks resume position itself, for example by
  reconnecting with `afterOffset`
- `DO-owned cursor` — the Durable Object persists progress and decides what to
  deliver next
- `head of stream` — the earliest readable position in the stream; in practice
  this means "from the beginning", before the first deliverable event
- `tail of stream` — the current end of the stream; in practice this means
  "from now", after the latest appended event
- `live tail` — an ephemeral open session that stays attached near the tail,
  receives newly appended events as they arrive, and leaves cursor ownership
  with the peer
- `subscription` — a durable delivery registration; the DO owns the cursor,
  delivery scheduling, retry state, and ack handling
- `target` — the destination a subscription delivers to, such as a webhook,
  another DO, or a websocket peer
- `delivery attempt` — one attempt by the DO to deliver one event for one
  subscription
- `ack` — the signal that lets the DO treat a delivery as resolved

### Shorthand bundles

These are useful terms, but they are shorthand for common bundles of
dimensions, not primary categories that replace the dimensions above.

- `live tail` — usually means an ephemeral open stream where the peer owns the
  cursor and reconnects with something like `afterOffset`
- `subscription` — usually means durable, registered delivery state where the
  DO owns the cursor and drives retries
- `webhook subscription` — usually means outbound HTTP + DO-owned cursor +
  `transport` ack
- `inbound websocket subscription` — usually means inbound WebSocket +
  DO-owned cursor + `explicit` ack
- `outbound websocket subscription` — usually means outbound WebSocket +
  DO-owned cursor + `explicit` ack

### Recommended language

- Say `consumer` when describing who receives events.
- Say `peer` when describing transport mechanics, connection setup, or socket
  protocol messages without wanting to imply a stronger role.
- Say `live tail` or `live reader` for open HTTP stream / websocket sessions
  where the peer owns the resume offset.
- Say `subscription` only for durable, slug-scoped delivery state where the DO
  owns the cursor.
- Say `peer-owned cursor` and `DO-owned cursor` instead of `client-managed` and
  `server-managed`. The transport role can flip, but cursor ownership remains
  the useful distinction.
- Say `inbound` and `outbound` relative to the DO.
- Say `head of stream` and `tail of stream` when you mean positions.
- Say `live tail` when you mean an ongoing session that keeps following newly
  appended events.
- Say `transport ack` when HTTP `2xx` or some transport-level success is enough.
- Say `explicit ack` when the peer must send an application-level ack message or
  callback before the DO advances its cursor.

### Terms to avoid

- Avoid calling a raw `stream({ live: true })` consumer a `subscription`.
- Avoid using `subscriber` for in-memory stream controllers.
- Avoid using `client` and `server` as the main taxonomy. They describe one
  transport interaction, not the durable delivery model.
- Avoid binary `acked` language when the distinction actually matters. Prefer
  `no ack`, `transport ack`, or `explicit ack`.
- Avoid `first` and `last` for cursor positions. Those sound like event
  identities, while `head` and `tail` describe positions in the log.

### Pressure test

Some permutations do not make much sense, and some terms stop being useful when
too many dimensions get collapsed into one word.

Two dimensions are especially easy to oversimplify:

- `Ack required or not` is too coarse. For this app the real vocabulary should
  be `none`, `transport`, and `explicit`.
- `Inbound or outbound` is not enough to name a flow. An inbound websocket can
  still be a durable subscription if the DO owns the cursor. An outbound HTTP
  request can still be stateless fanout if the DO does not own a cursor.

That is why this glossary treats terms like `live tail` and `subscription` as
convenient shorthand for common bundles, not as the first thing to classify.

The safer pattern is:

1. name the dimensions
2. check whether the combination is coherent
3. only then choose the shortest shorthand term that still tells the truth

### Head vs tail

These words are worth defining explicitly because `tail` can mean either a
position or an ongoing activity.

- `head of stream` means the beginning of the log, before the first deliverable
  event
- `tail of stream` means the current append end of the log, after the latest
  event that exists right now
- `tailing` or `live tail` means keeping a session open so new events continue
  to arrive after the current tail

Examples:

- `startFrom: "head"` means backfill from the beginning
- `startFrom: "tail"` means start at the current end and do not backfill older
  events
- `stream({ afterOffset, live: true })` means replay after the given cursor and
  then continue tailing live updates

`first` and `last` are usually worse here:

- `first event` and `last event` refer to concrete events
- `head` and `tail` refer to positions, which matches how cursors behave

If we ever want plainer API words than `head` and `tail`, `from-start` and
`from-current-end` would be clearer candidates than `first` and `last`.

### Permutation matrix

The table below lists the requested permutations of:

- direction relative to the DO
- websocket or plain HTTP
- whether the DO keeps the cursor
- whether explicit ack is required

Not every permutation is equally sensible. Some are first-class, some are
possible but awkward, and some should be avoided because the words suggest
stronger guarantees than the transport can provide.

| Direction | Transport | Cursor owner | Explicit ack? | What to call it                                | Example phrasing                                                                                      | Pressure test                                                                               |
| --------- | --------- | ------------ | ------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| inbound   | http      | peer         | no            | `live HTTP tail`                               | "The peer opened an inbound HTTP live tail and will resume itself with `afterOffset`."                | First-class. This is the current raw stream/read pattern.                                   |
| inbound   | http      | peer         | yes           | avoid                                          | "Avoid calling this an acked HTTP tail."                                                              | If the peer owns the cursor, explicit ack is usually redundant.                             |
| inbound   | http      | DO           | no            | `HTTP pull subscription`                       | "The worker is polling over HTTP, but the DO still owns the subscription cursor."                     | Possible, but this feels queue-like rather than stream-like.                                |
| inbound   | http      | DO           | yes           | `HTTP pull-and-ack subscription`               | "The peer fetches work over HTTP and explicitly acks offsets back to the DO."                         | Possible, but heavier than the current model and easy to overcomplicate.                    |
| inbound   | websocket | peer         | no            | `live websocket tail`                          | "The peer opened an inbound websocket tail and handles its own resume position."                      | Reasonable if the websocket is just a live session, not durable delivery.                   |
| inbound   | websocket | peer         | yes           | avoid                                          | "Avoid saying the DO is waiting for ack if the peer is the cursor authority."                         | Usually muddled. Ack without DO-owned progress does not buy much.                           |
| inbound   | websocket | DO           | no            | avoid                                          | "Avoid a websocket subscription that auto-advances on send."                                          | WebSocket has no useful per-message transport ack. This is too lossy for durable semantics. |
| inbound   | websocket | DO           | yes           | `inbound websocket subscription`               | "The peer opened a websocket subscription; the DO owns the cursor and waits for explicit ack frames." | First-class. This is the best websocket subscription shape.                                 |
| outbound  | http      | peer         | no            | `stateless outbound notification`              | "The DO posts outbound HTTP notifications, but the peer owns any replay story."                       | Valid, but this is not really a subscription in our terminology.                            |
| outbound  | http      | peer         | yes           | avoid                                          | "Avoid coupling outbound HTTP ack to a flow where the DO does not track progress."                    | If the DO is not the cursor authority, the ack has no durable effect here.                  |
| outbound  | http      | DO           | no            | `transport-acked webhook subscription`         | "The DO runs a webhook subscription and advances on HTTP success."                                    | First-class. In practice this usually means `transport` ack, not literally no ack.          |
| outbound  | http      | DO           | yes           | `explicitly acknowledged webhook subscription` | "The DO posts events but only advances after an explicit ack callback."                               | Valid and sometimes useful, but more operationally complex than transport ack.              |
| outbound  | websocket | peer         | no            | `outbound live push session`                   | "The DO dialed an outbound websocket live session, but the peer owns resume behavior."                | Possible, but this is an ephemeral session, not a durable subscription.                     |
| outbound  | websocket | peer         | yes           | avoid                                          | "Avoid explicit ack language when the DO is not the source of truth for progress."                    | Usually confused and hard to reason about.                                                  |
| outbound  | websocket | DO           | no            | `outbound websocket subscription without ack`  | "The DO pushes on an outbound websocket and advances immediately after send."                         | Technically possible, but not recommended. Too fragile for durable delivery.                |
| outbound  | websocket | DO           | yes           | `outbound websocket subscription`              | "The DO owns the cursor, opens the websocket, and waits for explicit app-level ack messages."         | Supported by the model. This is the right durable outbound websocket shape.                 |

### Common cases and the words to use

These are the combinations we expect to talk about most often:

- Inbound HTTP + peer-owned cursor + no explicit ack:
  call it a `live tail` or `live HTTP tail`, not a subscription.
- Outbound HTTP + DO-owned cursor + transport ack:
  call it a `webhook subscription`.
- Outbound HTTP + DO-owned cursor + explicit ack:
  call it an `explicitly acknowledged webhook subscription`.
- Inbound websocket + DO-owned cursor + explicit ack:
  call it an `inbound websocket subscription`.
- Outbound websocket + DO-owned cursor + explicit ack:
  call it an `outbound websocket subscription`.
- Outbound HTTP + peer-owned cursor + no ack:
  call it a `stateless notification` or `fanout`, not a subscription.

### Naming rule for code

When naming types, comments, and variables:

- start from the dimensions when precision matters
- use `subscription` for durable, DO-owned delivery state
- use `live tail`, `live reader`, or `live fanout` for ephemeral readers
- use `target` for where a subscription delivers
- use `peer-owned cursor` and `DO-owned cursor` in comments and docs

If a piece of state would disappear when the connection closes, it should
probably not be called a `subscription`. If a name hides an important
dimension, prefer a more explicit phrase over a shorter one.
