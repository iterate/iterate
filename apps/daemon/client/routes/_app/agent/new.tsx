import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/agent/new")({
  validateSearch: (search: Record<string, unknown>) => ({
    path: typeof search.path === "string" ? search.path : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/agents/new",
      search: { path: search.path },
    });
  },
});
