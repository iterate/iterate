import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-up/$")({
  beforeLoad: () => {
    throw redirect({ href: "/api/iterate-auth/login" });
  },
  component: () => <main className="grid min-h-svh place-items-center bg-background p-4" />,
});
