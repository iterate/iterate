import { createFileRoute } from "@tanstack/react-router";
import { createIterateClient } from "../client/browser.ts";

const iterate = createIterateClient({ scopes: ["iterate", "account"] });
export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
});
