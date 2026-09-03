import type { ProjectAiInterceptor } from "iterate/node";
import { installResilientAiInterceptor as installGeneric } from "@iterate-com/shared/test-support/resilient-ai-interceptor";
import { createAdminOsItx } from "./os-client.ts";

/**
 * The os e2e lane's churn-surviving `intercepted/*` handler: the shared
 * recovery loop (`@iterate-com/shared/test-support/resilient-ai-interceptor`)
 * dialing through this lane's admin session. Dispose with `await using`.
 * Guide: docs/intercepted-models.md.
 */
export function installResilientAiInterceptor(input: {
  baseUrl: string;
  /** Project id or slug, as `session.projects.get` accepts. */
  projectId: string;
  handler: ProjectAiInterceptor;
}): Promise<AsyncDisposable> {
  return installGeneric({
    projectId: input.projectId,
    handler: input.handler,
    connect: (options) => createAdminOsItx({ baseUrl: input.baseUrl, ...options }),
  });
}
