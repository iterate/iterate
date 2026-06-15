import { createFileRoute } from "@tanstack/react-router";
import { ConnectedItxRepl } from "~/routes/_app/itx-repl.tsx";

export const Route = createFileRoute("/admin/repl")({
  component: AdminReplPage,
});

function AdminReplPage() {
  return <ConnectedItxRepl context="global" />;
}
