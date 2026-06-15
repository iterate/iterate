import { useEffect, useMemo, useState } from "react";
import { useMatches, useNavigate } from "@tanstack/react-router";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { StreamSwitcherDialog } from "./stream-switcher-dialog.tsx";
import { connectItx } from "~/itx/itx-react.tsx";
import { OPEN_GLOBAL_COMMAND_PALETTE_EVENT } from "~/components/global-command-palette-events.ts";
import type {
  AppRouteStaticData,
  RouteBreadcrumbLoaderData,
  RouteCommandPaletteStaticData,
} from "~/lib/route-breadcrumbs.ts";
import type { StreamNavigator } from "~/lib/stream-navigation.ts";

const AGENTS_ROOT = StreamPath.parse("/agents");

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
        if (
          activeStream.mode === "agent" &&
          path !== AGENTS_ROOT &&
          path.startsWith(`${AGENTS_ROOT}/`)
        ) {
          void navigate({
            to: "/projects/$projectSlug/agents/streams/$",
            params: { projectSlug: activeStream.projectSlug, _splat: path },
            // Open the new stream with its own default tab and fresh filters
            // rather than carrying the previous stream's view state across.
            search: {},
          });
          return;
        }

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
      rootPath={activeStream.rootPath}
      scope={activeStream.projectId}
    />
  );
}

type ActiveStreamCommandContext = NonNullable<RouteBreadcrumbLoaderData["streamBreadcrumb"]> &
  NonNullable<NonNullable<RouteCommandPaletteStaticData["commandPalette"]>["stream"]>;

function getActiveStreamCommandContext(
  matches: ReturnType<typeof useMatches>,
): ActiveStreamCommandContext | null {
  const streamBreadcrumb = matches
    .map((match) => (match.loaderData as RouteBreadcrumbLoaderData | undefined)?.streamBreadcrumb)
    .filter((value): value is NonNullable<RouteBreadcrumbLoaderData["streamBreadcrumb"]> =>
      Boolean(value),
    )
    .at(-1);
  const streamCommand = matches
    .map((match) => (match.staticData as AppRouteStaticData | undefined)?.commandPalette?.stream)
    .filter(
      (
        value,
      ): value is NonNullable<
        NonNullable<RouteCommandPaletteStaticData["commandPalette"]>["stream"]
      > => Boolean(value),
    )
    .at(-1);

  if (streamBreadcrumb == null || streamCommand == null) return null;
  return {
    ...streamBreadcrumb,
    ...streamCommand,
    rootPath: streamCommand.rootPath ?? StreamPath.parse("/"),
  };
}
