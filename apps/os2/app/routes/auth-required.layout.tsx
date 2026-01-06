import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getContext } from "hono/context-storage";
import type { Variables } from "../../backend/worker.ts";
import type { CloudflareEnv } from "../../env.ts";

const getSessionFn = createServerFn({ method: "GET" }).handler(async () => {
  const c = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();
  return c.var.session;
});

export const Route = createFileRoute("/_auth.layout")({
  beforeLoad: async () => {
    const session = await getSessionFn();
    if (!session) {
      throw redirect({ to: "/login" });
    }
    return { session };
  },
  component: AuthRequiredLayout,
});

function AuthRequiredLayout() {
  return <Outlet />;
}
