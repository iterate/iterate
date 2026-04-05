import { createFileRoute, redirect } from "@tanstack/react-router";
import { defaultProjectSlug } from "~/lib/project-slug.ts";
import { defaultStreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({
      to: "/streams/",
      search: { ...defaultStreamViewSearch, projectSlug: defaultProjectSlug },
      replace: true,
    });
  },
});
