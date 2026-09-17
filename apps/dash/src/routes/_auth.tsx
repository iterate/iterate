import { createFileRoute } from "@tanstack/react-router";
import { createIterateClient } from "iterate/next/app";
// The dash asks for every scope: `iterate` (the projects), `account` (the sessions page: grants and
// personal access tokens), `organizations:write` (creating organizations). Consent is task-based —
// the person may untick the optional two — so the pages read `info.scopes` for what they may do and
// offer a step-up link for the rest.
const iterate = createIterateClient({ scopes: ["iterate", "account", "organizations:write"] });
export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
});
