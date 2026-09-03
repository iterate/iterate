import type { ProjectAiInterceptor } from "iterate/node";
import { installResilientAiInterceptor as installGeneric } from "@iterate-com/shared/test-support/resilient-ai-interceptor";
import { connectAdminItx } from "./forged-session.ts";

/**
 * The Playwright specs' churn-surviving `intercepted/*` handler: the shared
 * recovery loop (`@iterate-com/shared/test-support/resilient-ai-interceptor`)
 * dialing through the specs' forged admin session (`connectAdminItx`).
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
    connect: (options) => connectAdminItx(input.baseUrl, options),
  });
}
