import {
  DynamicWorkerOutboundGateway,
  type DynamicWorkerOutboundGateway as DynamicWorkerOutboundGatewayType,
} from "@iterate-com/events-contract";
import { dynamicWorkerEgressConfigHeader } from "./dynamic-worker-egress.ts";

type DynamicWorkerEgressGatewayProps = {
  secretHeaderName?: string;
  secretHeaderValue?: string;
};

export function parseDynamicWorkerEgressGatewayConfig(
  headerValue: string | null,
): DynamicWorkerEgressGatewayProps | undefined {
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

  return toGatewayProps(gateway.data);
}

function toGatewayProps(
  gateway: DynamicWorkerOutboundGatewayType,
): DynamicWorkerEgressGatewayProps | undefined {
  return gateway.props;
}
