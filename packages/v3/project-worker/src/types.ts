// types.ts — THE PUBLIC SURFACE, in one place to read and to import (`project-worker/types`).
//
// A client is JUST capnweb: you dial `/api`, and everything below is a typed proxy of the worker's
// own classes — no generated SDK, no second copy. The frontend imports these with `import type`, so
// nothing here reaches the browser bundle except the few values it deliberately uses. Read this file
// top-to-bottom to understand the whole API: the connection hierarchy, who you are, how hosts resolve,
// the org/project/user domain, what an event is, the processor contracts, and live state.
//
// Everything is re-exported from where it lives; this file adds the map and the examples, not new
// definitions — so the types stay honest with the implementation.

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE RPC HIERARCHY — what a `/api` connection hands you.
//
//   IterateRpcTarget      the fresh connection: one verb, `authenticate(credentials)`.
//     └─ SessionRpcTarget   who you are + your catalogs: `.whoami()`, `.user`, `.organizations`,
//          └─ IterateContextRpcTarget   ONE context (a user/org/project subtree): the full itx surface
//                                        (`append`, `readEvents`, `kv`, `facets`, `workers`, `cd`, …).
//
// A context is the same shape whether it is a project root, a user, or an org — `session.user` and
// `session.projects.get(id)` both return an `IterateContextRpcTarget`. `cd(path)` reaches a sibling
// context in the same namespace; the itx verbs (`append`, `kv`, …) act on the context you hold.
//
//   import { newWebSocketRpcSession } from "capnweb";
//   import type { IterateRpcTarget } from "project-worker/types";
//
//   const iterate = newWebSocketRpcSession<IterateRpcTarget>("wss://os.iterate2.com/api");
//   const session = iterate.authenticate({ type: "from-server-cookie" }); // → SessionRpcTarget
//   const project = await session.projects.get("prj_123");                // → IterateContextRpcTarget
//   await project.append({ type: "events.iterate.com/ping", payload: {} });
//   const { events } = await project.readEvents();
// ─────────────────────────────────────────────────────────────────────────────
export type { IterateRpcTarget, SessionRpcTarget } from "./session.ts";
export type { IterateContextRpcTarget } from "./iterate-context.ts";
/** The itx surface every context exposes — the verbs `IterateContextRpcTarget` carries (`append`,
 *  `readEvents`, `kv`, `secrets`, `facets`, `workers`, `rpcStubs`, `subscriptions`, `fetch`, …). */
export type { BuiltInScope } from "./context/built-ins.ts";
/** An itx call as the wire carries it: a dotted string (`"itx.kv.get('k')"`) or the parsed array
 *  form (`["itx", "kv", ["get", "k"]]`). `invoke(expression)` is the un-sugared twin of the dotted
 *  surface — `ctx.kv.get('k')` compiles to `ctx.invoke(["itx","kv",["get","k"]])`. */
export type { ItxExpression, ItxExpressionInput } from "./context/expression.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 2. AUTH — the credentials you authenticate with, and who you become.
//
// `authenticate(credentials)` takes a `SessionCredentials`: the browser hands `{ type:
// "from-server-cookie" }` (the OAuth gate already resolved the caller from the request), an operator
// hands `{ type: "admin-secret", secret }`. The resolved actor is a `Principal` (a stable `actor` id
// and, for a human, an `email`); `ProjectTokenClaims` is what a signed project token carries.
// ─────────────────────────────────────────────────────────────────────────────
export type { SessionCredentials, SessionPrincipal } from "./session.ts";
export type { Principal, ProjectTokenClaims } from "./principal.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 3. ROUTING — how a hostname resolves to a project + app.
//
// A project host is `<app>--<project>.<base>` (e.g. `notes--prj_123.iterate2.app`), the apex
// `<project>.<base>` (no app label → the project's config worker), or the dotted `<app>.<project>.<base>`
// (local dev). `projectHostOf(hostname, base)` parses it to `{ app, project }` (or null). The edge
// then dispatches the request into the project context as `itx.apps.<app>.fetch(request)`, and the
// config worker sees the app slug in the `x-iterate-app` header.
//
//   projectHostOf("notes--prj_123.iterate2.app", "iterate2.app") // → { app: "notes", project: "prj_123" }
//   projectHostOf("prj_123.iterate2.app",         "iterate2.app") // → { app: null,    project: "prj_123" }
// ─────────────────────────────────────────────────────────────────────────────
export { projectHostOf, hostnameLabelsUnderBase } from "./hosts.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 4. DOMAIN — organizations, users, projects, and what a session can reach.
//
// A `User` belongs to `Org`s; an `Org` owns `Project`s; in this deployment a project's id IS its
// DNS-safe slug. `Reach` is what a session may touch: `"every"` (the admin secret), the projects of a
// user's orgs (`{ userId }`), or a fixed set (`{ projectIds }`). `session.projects.list()/get()` and
// `session.organizations.get()` are bounded by it.
// ─────────────────────────────────────────────────────────────────────────────
export type { User, Org, Project, Reach } from "./directory.ts";
/** One DNS-safe name — the directory row, the DO name, and the host label are the same string. */
export type { ProjectIdOrSlug } from "./session.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 5. EVENTS — the append-only log every context carries.
//
// `StreamEventInput` is what you append (`type` + `payload` + optional `idempotencyKey`/`ephemeral`);
// `StreamEvent` is what comes back (input + `offset`, `createdAt`, provenance). Write events LITERALLY
// so the type string and payload are visible — there are no builder helpers.
//
//   await ctx.append({
//     type: "events.iterate.com/account/token-revoked",
//     payload: { requestId },
//     idempotencyKey: `token-revoke/${requestId}`,
//   });
// ─────────────────────────────────────────────────────────────────────────────
export type { StreamEvent, StreamEventInput } from "./stream/processor.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 6. PROCESSOR CONTRACTS & SCHEMAS — the event vocabulary + the reduced views.
//
// A processor declares a contract: its reduced-state schema, and an `events` map (each durable type
// string with its zod `payloadSchema`). `consumes`/`emits` list the type strings it folds/appends;
// `processorDeps` lets it use another contract's events. The reduce's event union and state type are
// DERIVED from the contract (`ConsumedEvent<typeof C>` / `ProcessorState<typeof C>`) — no hand-kept
// union. `AccountContract` is the worked example (authentications + tokens); its zod payload schemas
// are the readable spec of every account event.
//
//   import { AccountContract } from "project-worker/types";
//   AccountContract.events;                        // the vocabulary, type string → { payloadSchema }
//   type Account = ProcessorState<typeof AccountContract>;   // { authentications; tokens }
//
// These are VALUES (zod schemas), used server-side and to read the spec; the frontend takes only the
// TYPES above with `import type`.
// ─────────────────────────────────────────────────────────────────────────────
export { defineProcessorContract, StreamProcessor } from "./stream/processor.ts";
export type {
  ProcessorContract,
  EventDefinition,
  EventCatalog,
  ConsumedEvent,
  ProcessorState,
  ReduceArgs,
  ProcessEventArgs,
} from "./stream/processor.ts";
export { AccountContract } from "./account/contract.ts";
export type {
  AccountView,
  AuthenticationFact,
  TokenCreateRequest,
  TokenRevoke,
} from "./account/contract.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 7. LIVE STATE — a processor's view, pushed to the client as it changes.
//
// A processor projects its reduced state to a live view; a client subscribes and receives the seed
// then deltas. `connectLiveState` (project-worker/client) drives it; `useLiveState` (React) wraps it.
// The account/sessions pages are built entirely on this — create a token, the row appears at once.
// ─────────────────────────────────────────────────────────────────────────────
export type {
  LiveStateConnection,
  LiveStateItx,
  LiveStateDelta,
  LiveStateSeed,
  LiveStateStore,
} from "./client/live-state.ts";
