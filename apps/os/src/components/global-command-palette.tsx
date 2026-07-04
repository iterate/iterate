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
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/lib/stream-navigation.ts";
import { activeStreamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { fetchProjectsList, projectsListQueryKey } from "~/lib/projects-query.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
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
  // The picker step's choice (pages without route stream context). Cleared on
  // every close so the next ⌘K starts back at the picker — otherwise the
  // first-ever choice would lock the palette to that project on non-project
  // pages. Any route-provided context wins over it.
  const [pickedProject, setPickedProject] = useState<{ id: string; slug: string } | null>(null);
  const matches = useMatches();
  const navigate = useNavigate();
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setPickedProject(null);
  };
  // Context tiers: the admin explorer's project (params on the /admin/streams
  // routes) → the page's own stream (stream pages publish a streamBreadcrumb)
  // → the active project's root (any project page — the $projectSlug layout
  // carries `project` in its route context) → the picker dialog's choice
  // (non-project pages).
  const adminStream = useMemo(() => getAdminStreamContext(matches), [matches]);
  const routeStream = useMemo(() => {
    if (adminStream) return adminStream;
    const streamBreadcrumb = activeStreamBreadcrumb(matches);
    if (streamBreadcrumb) return streamBreadcrumb;
    const project = matches
      .map(
        (match) =>
          (match.context as { project?: { id: string; slug: string } } | undefined)?.project,
      )
      .filter(Boolean)
      .at(-1);
    return project ? { projectId: project.id, projectSlug: project.slug, streamPath: "/" } : null;
  }, [adminStream, matches]);
  const activeStream = useMemo(
    () =>
      routeStream ??
      (pickedProject
        ? { projectId: pickedProject.id, projectSlug: pickedProject.slug, streamPath: "/" }
        : null),
    [routeStream, pickedProject],
  );

  // Close on any navigation that swaps the stream context out from under an
  // open dialog (back button, links outside the dialog): the tree being shown
  // belongs to the page it was opened on. The palette's own navigations
  // already close it before routing.
  const routeStreamKey = routeStream ? `${routeStream.projectId}:${routeStream.streamPath}` : null;
  useEffect(() => {
    setOpen(false);
    setPickedProject(null);
  }, [routeStreamKey]);

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
    if (adminStream != null) {
      // Admin addresses arbitrary projects through the global (admin-cookie)
      // session and stays within the admin explorer routes.
      return {
        source: (path) => ({
          async subscribe(args) {
            const itx = await connectItxBrowser();
            const stream =
              adminStream.adminProjectId === NULL_DURABLE_OBJECT_PROJECT_ID
                ? itx.streams.get(path)
                : itx.projects.get(adminStream.adminProjectId).streams.get(path);
            return stream.subscribe(args);
          },
        }),
        onOpenPath(path) {
          setOpen(false);
          void navigate({
            to: "/admin/streams/$projectId/$",
            params: { projectId: adminStream.adminProjectId, _splat: path },
            search: {},
          });
        },
      };
    }
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
        void navigate(linkOptionsForStreamPath(activeStream.projectSlug, path));
      },
    };
  }, [activeStream, adminStream, navigate]);

  if (activeStream == null || streamNavigator == null) {
    return (
      <ProjectPickerDialog open={open} onOpenChange={handleOpenChange} onPick={setPickedProject} />
    );
  }

  return (
    <StreamSwitcherDialog
      open={open}
      onOpenChange={handleOpenChange}
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

/**
 * The admin stream explorer's ⌘K context: which project (or the `__null__`
 * deployment namespace) it is browsing and where it stands. Detected from the
 * /admin/streams/$projectId route params — admin navigates within its own
 * explorer routes and dials through the global admin session.
 */
function getAdminStreamContext(matches: ReturnType<typeof useMatches>) {
  const adminMatch = matches.find((match) => match.routeId.startsWith("/admin/streams/$projectId"));
  if (adminMatch == null) return null;
  const params = adminMatch.params as { projectId: string; _splat?: string };
  const deepest = matches.at(-1)?.params as { _splat?: string } | undefined;
  return {
    adminProjectId: params.projectId,
    projectId: params.projectId,
    projectSlug: params.projectId,
    streamPath: deepest?._splat ?? "/",
  };
}
