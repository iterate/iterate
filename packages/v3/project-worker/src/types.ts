// types.ts — THE TYPES A CLIENT AUTHOR IMPORTS (`project-worker/types`): what rides the wire and what
// the session and a context look like. Hand-written re-exports, full names, nothing generated — a
// client is JUST capnweb (iterate-context.ts), so a typed proxy of these classes is the whole SDK.

export type { IterateContext } from "./iterate-context.ts";
export type {
  ProjectIdOrSlug,
  SessionCredentials,
  SessionPrincipal,
  UnauthenticatedSession,
  Session,
} from "./session.ts";
export type { Principal, ProjectTokenClaims } from "./principal.ts";
export type { BuiltInScope } from "./context/built-ins.ts";
export type { ItxExpression, ItxExpressionInput } from "./context/expression.ts";
export type { StreamEvent, StreamEventInput } from "./stream/processor.ts";
export type { LiveStateConnection, LiveStateItx } from "./client/live-state.ts";
export type { LiveStateDelta, LiveStateSeed, LiveStateStore } from "./client/live-state.ts";
