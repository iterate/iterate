import { expandOAuthResourceAudienceVariants } from "@iterate-com/shared/oauth-resource";

export function getOsResourceBases() {
  return [
    "https://os.iterate.com",
    "http://localhost:5173",
    // Fully-local dev runs on arbitrary ports (http://os.localhost:<port>), so
    // the RFC 8707 resource/audience is the stable portless loopback origin —
    // OS sets APP_CONFIG_ITERATE_AUTH__RESOURCE to match.
    "http://os.localhost",
    "http://localhost",
    "http://127.0.0.1",
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (previewNumber) => `https://os.iterate-preview-${previewNumber}.com`,
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
