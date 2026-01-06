import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getContext } from "hono/context-storage";
import type { Variables } from "../../backend/worker.ts";
import type { CloudflareEnv } from "../../env.ts";

const getFirstOrganizationFn = createServerFn({ method: "GET" }).handler(async () => {
  const c = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();
  const result = await c.var.trpcCaller.user.organizationsWithProjects();
  return result[0]?.organization || null;
});

export const Route = createFileRoute("/_auth.layout/")({
  beforeLoad: async () => {
    const org = await getFirstOrganizationFn();
    if (org) {
      throw redirect({ to: "/$organizationSlug", params: { organizationSlug: org.slug } });
    }
    throw redirect({ to: "/new-organization" });
  },
  component: () => null,
});
