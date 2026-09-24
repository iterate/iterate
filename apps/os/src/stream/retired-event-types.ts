// retired-event-types.ts — durable core event types that were renamed, refused at the append
// boundary (`normalizeControlEvent`) with their new name. An event type is a plain string, so a
// caller still spelling an old name would otherwise append a fact no reduce reads: a pause that
// never pauses, a subscription row that is never delivered. The naming rules are in
// packages/iterate/README.md#event-types.
//
// Only the core's durable types are here. A renamed ephemeral type (`itx/alarm-trace`,
// `itx/live-state-changed`, `itx/rpc-stub-*`) is accepted under its old name, so an older SDK
// host's batch never fails; a renamed domain type (`organization/project-added`, `voice-agent/*`,
// …) is appended only by platform code. lint/event-types.test.ts keeps every old name, domain types
// included, out of this repository.
//
// Remove this map after 2026-10-31, once no deployment, open branch or project config repo
// appends an old name.

/** Every retired durable core type, old → new. */
export const RETIRED_EVENT_TYPES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    "stream/created": "itx/created",
    "stream/woken": "itx/woken",
    "stream/paused": "itx/paused",
    "stream/resumed": "itx/resumed",
    "context/aborted": "itx/aborted",
    "context/facet-aborted": "itx/facet-aborted",
    "context/child-created": "itx/descendant-created",
    "context/run-requested": "itx/run-requested",
    "context/run-settled": "itx/run-settled",
    "stream/subscription-configured": "itx/subscription-configured",
    "stream/subscription-delivery-halted": "itx/subscription-delivery-halted",
    "stream/subscription-delivery-resumed": "itx/subscription-delivery-resumed",
    "stream/append-scheduled": "itx/schedule-set",
    "stream/append-schedule-cancelled": "itx/schedule-cancelled",
    "stream/append-schedule-completed": "itx/schedule-fired",
    "stream/append-schedule-failed": "itx/schedule-failed",
    "fetch-route/configured": "itx/fetch-route-configured",
    "ingress-route/configured": "itx/fetch-route-configured",
    "project/ingress-configured": "itx/ingress-configured",
  }).map(([old, renamed]) => [`events.iterate.com/${old}`, `events.iterate.com/${renamed}`]),
);

/** Why `event` cannot be appended, when its type was renamed; `undefined` otherwise. */
export function retiredEventTypeRefusal(event: { type: unknown }): string | undefined {
  const type = String(event.type);
  const renamed = RETIRED_EVENT_TYPES.get(type);
  return renamed && `${type} was renamed to ${renamed}: append ${renamed} instead`;
}
