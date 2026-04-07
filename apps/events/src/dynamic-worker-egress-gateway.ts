import { WorkerEntrypoint } from "cloudflare:workers";
import { replaceIterateSecretReferences } from "~/lib/iterate-secret-references.ts";

export type DynamicWorkerEgressGatewayProps = {
  secretHeaderName?: string;
  secretHeaderValue?: string;
  secretsByName?: Record<string, string>;
};

export class DynamicWorkerEgressGateway extends WorkerEntrypoint<
  Env,
  DynamicWorkerEgressGatewayProps
> {
  async fetch(request: Request) {
    const headers = new Headers(request.headers);

    if ((this.ctx.props.secretHeaderName == null) !== (this.ctx.props.secretHeaderValue == null)) {
      throw new Error(
        "DynamicWorkerEgressGateway requires secretHeaderName and secretHeaderValue together.",
      );
    }

    if (this.ctx.props.secretHeaderName != null && this.ctx.props.secretHeaderValue != null) {
      headers.set(this.ctx.props.secretHeaderName, this.ctx.props.secretHeaderValue);
    }

    const replacedHeaderNames: string[] = [];
    const resolvedSecretKeys = new Set<string>();
    const secretsByName = this.ctx.props.secretsByName ?? {};
    const target = new URL(request.url);

    try {
      for (const [headerName, headerValue] of Array.from(headers.entries())) {
        const resolved = await replaceIterateSecretReferences({
          input: headerValue,
          loadSecret: async (secretKey) => {
            const value = secretsByName[secretKey];
            if (typeof value !== "string") {
              throw new Error(`Secret "${secretKey}" was not found in apps/events secrets.`);
            }

            return value;
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
