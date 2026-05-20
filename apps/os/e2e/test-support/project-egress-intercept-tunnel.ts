import { createCaptunTunnel } from "captun/client";
import type { Project } from "@iterate-com/os-contract";
import { requireAdminBearerToken } from "./os-client.ts";

type ProjectWithIngressUrl = Project & { ingressUrl: string };

export async function useProjectEgressInterceptTunnel(input: {
  project: ProjectWithIngressUrl;
  fetch: Parameters<typeof createCaptunTunnel>[0]["fetch"];
}) {
  return createCaptunTunnel({
    url: `${input.project.ingressUrl}/__iterate/intercept-project-egress`,
    headers: { Authorization: `Bearer ${requireAdminBearerToken()}` },
    fetch: input.fetch,
  });
}
