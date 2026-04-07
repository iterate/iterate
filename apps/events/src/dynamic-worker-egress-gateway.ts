import { WorkerEntrypoint } from "cloudflare:workers";
import { replaceIterateSecretReferences } from "~/lib/iterate-secret-references.ts";

const dynamicWorkerEgressConfigHeader = "x-iterate-dynamic-worker-egress-config";

export type DynamicWorkerEgressGatewayProps = {
  secretHeaderName?: string;
  secretHeaderValue?: string;
};

export class DynamicWorkerEgressGateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    const headers = new Headers(request.headers);
    const target = new URL(request.url);
    const gatewayConfig = parseDynamicWorkerEgressGatewayConfig(
      headers.get(dynamicWorkerEgressConfigHeader),
    );

    headers.delete(dynamicWorkerEgressConfigHeader);

    if ((gatewayConfig?.secretHeaderName == null) !== (gatewayConfig?.secretHeaderValue == null)) {
      throw new Error(
        "DynamicWorkerEgressGateway requires secretHeaderName and secretHeaderValue together.",
      );
    }

    if (gatewayConfig?.secretHeaderName != null && gatewayConfig.secretHeaderValue != null) {
      headers.set(gatewayConfig.secretHeaderName, gatewayConfig.secretHeaderValue);
    }

    const replacedHeaderNames: string[] = [];
    const resolvedSecretKeys = new Set<string>();

    try {
      for (const [headerName, headerValue] of Array.from(headers.entries())) {
        const resolved = await replaceIterateSecretReferences({
          input: headerValue,
          loadSecret: async (secretKey) => {
            const result = await this.env.DB.prepare("SELECT value FROM secrets WHERE name = ?")
              .bind(secretKey)
              .first<{ value: string }>();

            if (typeof result?.value !== "string") {
              throw new Error(`Secret "${secretKey}" was not found in apps/events secrets.`);
            }

            return result.value;
          },
        });

        if (resolved.secretKeys.length === 0) {
          continue;
        }

        headers.set(headerName, resolved.output);
        replacedHeaderNames.push(headerName);

        for (const secretKey of resolved.secretKeys) {
          resolvedSecretKeys.add(secretKey);
        }
      }
    } catch (error) {
      console.error("[dynamic-worker-egress] failed to resolve iterate secrets", {
        error: error instanceof Error ? error.message : error,
        headerNames: Array.from(headers.keys()),
        method: request.method,
        pathname: target.pathname,
        secretKeys: Array.from(resolvedSecretKeys),
        url: target.origin,
      });
      throw error;
    }

    if (resolvedSecretKeys.size > 0) {
      console.log("[dynamic-worker-egress] resolved iterate secrets", {
        headerNames: replacedHeaderNames,
        method: request.method,
        pathname: target.pathname,
        replacementCount: replacedHeaderNames.length,
        secretKeys: Array.from(resolvedSecretKeys),
        url: target.origin,
      });
    }

    return fetch(
      new Request(request, {
        headers,
      }),
    );
  }
}

function parseDynamicWorkerEgressGatewayConfig(
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

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DynamicWorkerEgressGateway received a non-object config header.");
  }

  const props =
    "props" in parsed &&
    parsed.props != null &&
    typeof parsed.props === "object" &&
    !Array.isArray(parsed.props)
      ? (parsed.props as DynamicWorkerEgressGatewayProps)
      : undefined;

  return props;
}
