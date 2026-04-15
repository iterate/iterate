export {
  fromTrafficWithWebSocket,
  type FromTrafficWithWebSocketOptions,
  type TrafficReplayHandler,
} from "./replay/from-traffic-with-websocket.ts";
export {
  createProxyRequestTransform,
  createProxyWebSocketUrlTransform,
  PROXY_HEADERS_TO_STRIP,
} from "./server/proxy-request-transform.ts";
export { HarRecorder, type RecorderOpts } from "./har/har-recorder.ts";
export {
  createDefaultHarSanitizer,
  formatSanitizedSecret,
  isIterateSecretPlaceholder,
  isRedactedSecret,
  type HarEntrySanitizer,
} from "./har/har-sanitizer.ts";
export {
  useMitmProxy,
  useMockHttpServer,
  useTemporaryDirectory,
  type MockHttpServerFixture,
  type MockHttpServer,
  type UseMockHttpServerOptions,
} from "./server/mock-http-server-fixture.ts";
// Re-export the MSW helpers that create handlers so consumers use the same MSW
// module instance that mock-http-proxy's native server expects at runtime.
export { http, HttpResponse, ws } from "msw";
export type {
  HarEntryWithExtensions,
  HarWebSocketMessage,
  HarWithExtensions,
} from "./har/har-extensions.ts";
export {
  formatHarEntry,
  formatHarEntryOneLine,
  type FormatHarEntryOptions,
} from "./har/har-format.ts";
