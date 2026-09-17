import { createFileRoute } from "@tanstack/react-router";
import { createIterateClient } from "iterate/next/app";
// The sessions page manages OAuth grants and mints personal access tokens: that is the `account`
// scope, on top of the `iterate` scope every project page needs.
const iterate = createIterateClient({ scopes: ["iterate", "account"] });
export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
});
