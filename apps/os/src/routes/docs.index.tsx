import { createFileRoute } from "@tanstack/react-router";
import { DocsHomePage } from "~/components/docs-portal.tsx";

export const Route = createFileRoute("/docs/")({
  component: DocsHomePage,
});
