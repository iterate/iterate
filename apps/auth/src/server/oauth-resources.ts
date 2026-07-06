import { expandOAuthResourceAudienceVariants } from "@iterate-com/shared/oauth-resource";

export function getOsResourceBases() {
  return [
    "https://os.iterate.com",
    "http://localhost:5173",
    // Fully-local dev runs on arbitrary ports (http://localhost:<port>), so
    // the RFC 8707 resource/audience is the stable portless loopback origin —
    // OS sets APP_CONFIG_ITERATE_AUTH__RESOURCE to match.
    "http://localhost",
    "http://127.0.0.1",
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (previewNumber) => `https://os.iterate-preview-${previewNumber}.com`,
    ),
  ];
}

/**
 * Semaphore is a relying party like OS (browser sign-in + bearer access
 * tokens against its own origin as the RFC 8707 resource). Local dev is
 * covered by the portless loopback origins in getOsResourceBases.
 */
export function getSemaphoreResourceBases() {
  return [
    "https://semaphore.iterate.com",
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (previewNumber) => `https://semaphore.iterate-preview-${previewNumber}.com`,
    ),
  ];
}

/**
 * The streams playground is a relying party like OS and semaphore (browser
 * sign-in + bearer access tokens against its own workers.dev origin as the
 * RFC 8707 resource). Local dev is auth-less by design and needs no entry.
 */
export function getStreamsExampleResourceBases() {
  return [
    "https://streams-example-app-prd.iterate.workers.dev",
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (previewNumber) =>
        `https://streams-example-app-preview-${previewNumber}.iterate-dev-preview.workers.dev`,
    ),
  ];
}

export function getOsMcpResourceBases() {
  return expandOAuthResourceAudienceVariants([
    "https://mcp.iterate.com",
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (previewNumber) => `https://mcp.iterate-preview-${previewNumber}.com`,
    ),
    "http://localhost:7301/api/__mcp",
  ]);
}
