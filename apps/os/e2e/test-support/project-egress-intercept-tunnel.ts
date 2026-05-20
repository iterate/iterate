import { createCaptunTunnel } from "captun/client";
import type { Project } from "@iterate-com/os-contract";
import { requireAdminBearerToken } from "./os-client.ts";

export const PROJECT_EGRESS_INTERCEPT_ROUTE = "/__iterate/intercept-project-egress";
type ProjectWithIngressUrl = Project & { ingressUrl: string };

export async function useProjectEgressInterceptTunnel(input: {
  fetch: typeof fetch;
  project: ProjectWithIngressUrl;
}): Promise<AsyncDisposable> {
  const url = projectEgressInterceptUrlFor(input.project);
  const tunnel = await createCaptunTunnel({
    url,
    headers: {
      Authorization: `Bearer ${requireAdminBearerToken()}`,
    },
    fetch: input.fetch,
  });

  return {
    async [Symbol.asyncDispose]() {
      tunnel[Symbol.dispose]();
    },
  };
}

export function projectEgressInterceptUrlFor(project: ProjectWithIngressUrl) {
  return new URL(PROJECT_EGRESS_INTERCEPT_ROUTE, project.ingressUrl);
}
