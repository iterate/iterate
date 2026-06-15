import { createFileRoute, redirect } from "@tanstack/react-router";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/streams/$")({
  validateSearch: StreamViewSearch,
  params: {
    parse: (raw) => ({
      _splat: streamPathFromSplat(raw._splat),
    }),
    stringify: (parsed) => ({
      _splat: streamPathToSplat(parsed._splat),
    }),
  },
  loader: ({ params }) => {
    throw redirect({
      to: "/projects/$projectSlug/streams/$",
      params: {
        projectSlug: params.projectSlug,
        _splat: params._splat,
      },
      replace: true,
    });
  },
});
