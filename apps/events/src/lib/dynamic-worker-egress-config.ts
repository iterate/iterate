import { DynamicWorkerOutboundGateway } from "@iterate-com/events-contract";
import { dynamicWorkerEgressConfigHeader } from "./dynamic-worker-egress.ts";

export function parseDynamicWorkerEgressGatewayConfig(
  headerValue: string | null,
): { secretHeaderName?: string; secretHeaderValue?: string } | undefined {
  if (headerValue == null) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(headerValue);
  } catch (error) {
    console.error("[dynamic-worker-egress] failed to parse gateway config header", {
      error: error instanceof Error ? error.message : error,
      headerName: dynamicWorkerEgressConfigHeader,
    });
    throw new Error("DynamicWorkerEgressGateway received an invalid config header.");
  }

  const gateway = DynamicWorkerOutboundGateway.safeParse(parsed);

  if (!gateway.success) {
    console.error("[dynamic-worker-egress] invalid gateway config header", {
      errors: gateway.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path,
      })),
      headerName: dynamicWorkerEgressConfigHeader,
    });
    throw new Error("DynamicWorkerEgressGateway received an invalid outbound gateway config.");
  }

  return gateway.data.props;
}
