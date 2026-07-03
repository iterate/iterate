import { useEffect, useMemo, useState } from "react";
import { useMatches, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@iterate-com/ui/components/dialog";
import { StreamSwitcherDialog } from "./stream-switcher-dialog.tsx";
import { connectItxBrowser } from "~/itx/itx-react.tsx";
import { OPEN_GLOBAL_COMMAND_PALETTE_EVENT } from "~/components/global-command-palette-events.ts";
import type { RouteBreadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { fetchProjectsList, projectsListQueryKey } from "~/lib/projects-query.ts";
import { linkOptionsForStreamPath, StreamPath } from "~/lib/stream-links.ts";
import type { StreamNavigator } from "~/lib/stream-navigation.ts";

/**
 * The ⌘K stream switcher, live on EVERY app page. The active project and
 * stream come from the deepest route match that published a streamBreadcrumb
 * (every project-scoped page does); outside a project (the projects list,
 * new-project, the session REPL) the dialog first asks which project to
 * browse, then shows that project's stream tree from the root.
 */
export function GlobalCommandPalette() {
  const [open, setOpen] = useState(false);
  // Tier-3 project choice, kept across dialog closes within the page; any
  // route-provided context wins over it.
  const [pickedProject, setPickedProject] = useState<{ id: string; slug: string } | null>(null);
  const matches = useMatches();
  const navigate = useNavigate();
  const routeStream = useMemo(() => getRouteStreamContext(matches), [matches]);
  const activeStream = useMemo(
    () =>
      routeStream ??
      (pickedProject
        ? {
            projectId: pickedProject.id,
            projectSlug: pickedProject.slug,
            streamPath: StreamPath.parse("/"),
          }
        : null),
    [routeStream, pickedProject],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setOpen((current) => !current);
    }

    function onOpenPalette() {
      setOpen(true);
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_GLOBAL_COMMAND_PALETTE_EVENT, onOpenPalette);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_GLOBAL_COMMAND_PALETTE_EVENT, onOpenPalette);
    };
  }, []);

  const streamNavigator = useMemo<StreamNavigator | null>(() => {
    if (activeStream == null) return null;
    return {
      source: (path) => ({
        async subscribe(args) {
          // Key by project ID so we share the project provider's pooled socket.
          const itx = await connectItxBrowser({ projectId: activeStream.projectId });
          return itx.streams.get(path).subscribe(args);
        },
      }),
      onOpenPath(path) {
        setOpen(false);
        void navigate(linkOptionsForStreamPath(activeStream.projectSlug, StreamPath.parse(path)));
      },
    };
  }, [activeStream, navigate]);

  if (activeStream == null || streamNavigator == null) {
    return <ProjectPickerDialog open={open} onOpenChange={setOpen} onPick={setPickedProject} />;
  }

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

/**
 * The ⌘K first step outside any project: pick which project's streams to
 * browse. The list is the same cached itx `projects.list()` the sidebar keeps
 * warm, so this is usually instant.
 */
function ProjectPickerDialog({
  onOpenChange,
  onPick,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  onPick: (project: { id: string; slug: string }) => void;
  open: boolean;
}) {
  const { data: projects } = useQuery({
    queryKey: projectsListQueryKey,
    queryFn: fetchProjectsList,
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Streams</DialogTitle>
          <DialogDescription>Pick a project to browse its streams.</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto">
          {projects == null ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading projects…</p>
          ) : projects.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No projects yet.</p>
          ) : (
            projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => onPick({ id: project.id, slug: project.slug })}
              >
                <span className="min-w-0 truncate">{project.slug}</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                  {project.id}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function getRouteStreamContext(matches: ReturnType<typeof useMatches>) {
  return (
    matches
      .map((match) => (match.loaderData as RouteBreadcrumbLoaderData | undefined)?.streamBreadcrumb)
      .filter((value): value is NonNullable<RouteBreadcrumbLoaderData["streamBreadcrumb"]> =>
        Boolean(value),
      )
      .at(-1) ?? null
  );
}
