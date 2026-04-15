import { WorkerEntrypoint } from "cloudflare:workers";
import { ProjectSlug } from "@iterate-com/events-contract";
import { parseDynamicWorkerEgressGatewayConfig } from "~/lib/dynamic-worker-egress-config.ts";
import {
  dynamicWorkerEgressConfigHeader,
  dynamicWorkerProjectSlugHeader,
} from "~/lib/dynamic-worker-egress.ts";
import { replaceIterateSecretReferences } from "~/lib/iterate-secret-references.ts";

export class DynamicWorkerEgressGateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    const headers = new Headers(request.headers);
    const target = new URL(request.url);
    const gatewayConfig = parseDynamicWorkerEgressGatewayConfig(
      headers.get(dynamicWorkerEgressConfigHeader),
    );
    const parsedProjectSlug = ProjectSlug.safeParse(headers.get(dynamicWorkerProjectSlugHeader));

    headers.delete(dynamicWorkerEgressConfigHeader);
    headers.delete(dynamicWorkerProjectSlugHeader);

    if (gatewayConfig == null) {
      return fetch(
        new Request(request, {
          headers,
        }),
      );
    }
    if (!parsedProjectSlug.success) {
      throw new Error("DynamicWorkerEgressGateway requires a valid project slug header.");
    }
    const projectSlug = parsedProjectSlug.data;

    if ((gatewayConfig.secretHeaderName == null) !== (gatewayConfig.secretHeaderValue == null)) {
      throw new Error(
        "DynamicWorkerEgressGateway requires secretHeaderName and secretHeaderValue together.",
      );
    }

    if (gatewayConfig.secretHeaderName != null && gatewayConfig.secretHeaderValue != null) {
      headers.set(gatewayConfig.secretHeaderName, gatewayConfig.secretHeaderValue);
    }

    const replacedHeaderNames: string[] = [];
    const resolvedSecretKeys = new Set<string>();

    try {
      for (const [headerName, headerValue] of Array.from(headers.entries())) {
        const resolved = await replaceIterateSecretReferences({
          input: headerValue,
          loadSecret: async (secretKey) => {
            const result = await this.env.DB.prepare(
              "SELECT value FROM secrets WHERE project_slug = ? AND name = ?",
            )
              .bind(projectSlug, secretKey)
              .first<{ value: string }>();

            if (typeof result?.value !== "string") {
              throw new Error(`Secret "${secretKey}" was not found in project "${projectSlug}".`);
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
        projectSlug,
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
        projectSlug,
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
