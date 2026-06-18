import { Stream } from "@iterate-com/os/src/domains/streams/engine/workers/durable-objects/stream.ts";

// The reference implementation uses the real apps/os Stream Durable Object, but
// gives it a domain-local class name so the Worker binding table reads like the
// rest of this app: PROJECT, AGENT, REPO, STREAM are all local domain objects.
export class StreamDurableObject extends Stream {}
