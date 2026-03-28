import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

const getSession = createServerFn().handler(({ context }) => {
  const { session } = context.variables;
  return session;
});

export const Route = createFileRoute("/_auth")({
  beforeLoad: async ({ location }) => {
    const session = await getSession();
    if (!session) throw redirect({ to: "/login", search: { redirect: location.href } });
    return { session };
  },
  errorComponent: ({ error }) => {
    console.error(error);
    return <div>Error: {error.message}</div>;
  },
});
