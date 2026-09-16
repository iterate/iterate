import { createFileRoute } from "@tanstack/react-router";
import { createIterateClient } from "os-next/app";

// Minting the device's access token needs the account scope on top of project access.
const iterate = createIterateClient({ scopes: ["account"] });
export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
});
