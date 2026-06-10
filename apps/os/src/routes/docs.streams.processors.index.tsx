import { createFileRoute } from "@tanstack/react-router";
import { StreamProcessorsIndexPage } from "~/components/docs-portal.tsx";

export const Route = createFileRoute("/docs/streams/processors/")({
  component: StreamProcessorsIndexPage,
});
