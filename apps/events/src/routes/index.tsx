import { createFileRoute, redirect } from "@tanstack/react-router";
import { defaultStreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/streams/", search: defaultStreamViewSearch, replace: true });
  },
});
