import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useAuthClient } from "~/auth/client.tsx";

export const Route = createFileRoute("/sign-up/$")({
  component: SignUpRoute,
});

function SignUpRoute() {
  const auth = useAuthClient();

  useEffect(() => {
    auth.signIn();
  }, [auth]);

  return <main className="grid min-h-svh place-items-center bg-background p-4" />;
}
