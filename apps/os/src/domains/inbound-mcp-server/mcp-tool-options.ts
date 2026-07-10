export type InboundMcpToolOptions = {
  withAgent: boolean;
};

export function readInboundMcpToolOptions(request: Request): InboundMcpToolOptions {
  const url = new URL(request.url);
  return {
    withAgent: url.searchParams.get("withAgent") === "true",
  };
}
