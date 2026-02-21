/**
 * @iterate-com/events-service
 *
 * Effect-native event streaming infrastructure
 */

// Domain types
export { Event, Offset, Payload, StreamPath } from "../effect-stream-manager/domain.ts";

// Services
export * as StreamStorage from "../effect-stream-manager/services/stream-storage/index.ts";
export * as StreamManager from "../effect-stream-manager/services/stream-manager/index.ts";
export * as StreamClient from "../effect-stream-manager/services/stream-client/index.ts";

// oRPC interface
export {
  createEventBusClient,
  createEventBusOpenApiClient,
  createEventBusWebSocketClient,
} from "./orpc/client.ts";

// SSE utilities
export * as Sse from "../effect-stream-manager/sse.ts";
