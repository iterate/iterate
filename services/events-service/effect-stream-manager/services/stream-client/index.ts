/**
 * StreamClient - Effect service for consuming durable streams
 */

// Re-export service definition
export type { StreamClientConfig } from "./service.ts";
export { StreamClient, StreamClientError } from "./service.ts";

// Re-export layer
export { liveLayer } from "./live.ts";
