import { createFileRoute } from "@tanstack/react-router";
import { iterate } from "./-client.ts";

export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
});
