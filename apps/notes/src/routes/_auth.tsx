import { createFileRoute } from "@tanstack/react-router";
import { createIterateClient } from "os-next/app";
const iterate = createIterateClient();
export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
});
