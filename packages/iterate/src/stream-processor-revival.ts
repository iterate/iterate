/**
 * The one platform revival fact used by every recovery-wired stream
 * processor. The processor slug in the payload identifies the revived
 * processor; the shared event type lets the runner enforce recovery wiring.
 */
export const STREAM_PROCESSOR_REVIVED_EVENT_TYPE = "events.iterate.com/stream/processor-revived";
