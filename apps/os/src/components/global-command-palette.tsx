import { useEffect, useMemo, useState } from "react";
import { useMatches, useNavigate } from "@tanstack/react-router";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { StreamSwitcherDialog } from "./stream-switcher-dialog.tsx";
import { connectItx } from "~/itx/itx-react.tsx";
import { OPEN_GLOBAL_COMMAND_PALETTE_EVENT } from "~/components/global-command-palette-events.ts";
import type { RouteBreadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import type { StreamNavigator } from "~/lib/stream-navigation.ts";

export function GlobalCommandPalette() {
  const [open, setOpen] = useState(false);
  const matches = useMatches();
  const navigate = useNavigate();
  const activeStream = useMemo(() => getActiveStreamCommandContext(matches), [matches]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      if (activeStream == null) return;
      event.preventDefault();
      setOpen((current) => !current);
    }

    function onOpenPalette() {
      if (activeStream == null) return;
      setOpen(true);
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_GLOBAL_COMMAND_PALETTE_EVENT, onOpenPalette);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_GLOBAL_COMMAND_PALETTE_EVENT, onOpenPalette);
    };
  }, [activeStream]);

  useEffect(() => {
    if (activeStream == null) setOpen(false);
  }, [activeStream]);

  const streamNavigator = useMemo<StreamNavigator | null>(() => {
    if (activeStream == null) return null;
    return {
      source: (path) => ({
        async subscribe(args) {
          // Key by slug so we share the project provider's pooled socket.
          const itx = await connectItx({ projectId: activeStream.projectSlug });
          return itx.streams.get(path).subscribe(args);
        },
      }),
      onOpenPath(path) {
        setOpen(false);
        void navigate({
          to: "/projects/$projectSlug/streams/$",
          params: { projectSlug: activeStream.projectSlug, _splat: path },
          search: {},
        });
      },
    };
  }, [activeStream, navigate]);

  if (activeStream == null || streamNavigator == null) return null;

  return (
    <StreamSwitcherDialog
      open={open}
      onOpenChange={setOpen}
      currentPath={activeStream.streamPath}
      navigator={streamNavigator}
      scope={activeStream.projectId}
    />
  );
}

type ActiveStreamCommandContext = {
  projectId: string;
  projectSlug: string;
  streamPath: StreamPath;
};

function getActiveStreamCommandContext(
  matches: ReturnType<typeof useMatches>,
): ActiveStreamCommandContext | null {
  const streamBreadcrumb = matches
    .map((match) => (match.loaderData as RouteBreadcrumbLoaderData | undefined)?.streamBreadcrumb)
    .filter((value): value is NonNullable<RouteBreadcrumbLoaderData["streamBreadcrumb"]> =>
      Boolean(value),
    )
    .at(-1);
  const project = matches
    .map((match) => (match.loaderData as RouteBreadcrumbLoaderData | undefined)?.project)
    .filter((value): value is NonNullable<RouteBreadcrumbLoaderData["project"]> => Boolean(value))
    .at(-1);

  if (streamBreadcrumb == null && project == null) return null;

  const projectId = streamBreadcrumb?.projectId ?? project!.id;
  const projectSlug = streamBreadcrumb?.projectSlug ?? project!.slug;
  const streamPath = streamBreadcrumb?.streamPath ?? StreamPath.parse("/");

  return {
    projectId,
    projectSlug,
    streamPath,
  };
}
