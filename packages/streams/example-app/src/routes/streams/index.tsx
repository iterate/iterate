import { createFileRoute } from "@tanstack/react-router";
import { parseStreamViewSearch } from "../../lib/stream-view-search.ts";
import { StreamPage } from "../-stream-page.tsx";

export const Route = createFileRoute("/streams/")({
  validateSearch: (search) => parseStreamViewSearch({ search }),
  component: StreamsIndexRoute,
});

function StreamsIndexRoute() {
  const streamView = Route.useSearch();
  return <StreamPage streamView={streamView} />;
}
