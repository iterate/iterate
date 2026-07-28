import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useMatches, useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@iterate-com/ui/components/dialog";
import { connectItx, connectIterateSession, useIterateSessionQuery } from "iterate/sdk/itx/react";
import { OPEN_GLOBAL_COMMAND_PALETTE_EVENT } from "~/components/global-command-palette-events.ts";
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/lib/stream-navigation.ts";
import { activeStreamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { projectsListStaleTime } from "~/lib/projects-query.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import type { StreamNavigator } from "~/lib/stream-navigation.ts";

const CommandPaletteDialog = lazy(() =>
  import("./command-palette-dialog.tsx").then((module) => ({
    default: module.CommandPaletteDialog,
  })),
);

/**
 * The global ⌘K navigator, live on every app page. The active project and
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
  // Under /admin but before a project is chosen (the /admin/streams picker
  // page), ⌘K must stay in the admin world: picking a project opens that
  // project's admin explorer instead of dialing the org-scoped app flow.
  const inAdmin = matches.some((match) => match.routeId.startsWith("/admin"));
  const routeStream = useMemo(() => {
    if (adminStream) return adminStream;
    const streamBreadcrumb = activeStreamBreadcrumb(matches);
    if (streamBreadcrumb) return streamBreadcrumb;
    let project: { id: string; slug: string } | undefined;
    for (const match of matches) {
      const candidate = (match.context as { project?: { id: string; slug: string } } | undefined)
        ?.project;
      if (candidate !== undefined) project = candidate;
    }
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
      // Admin addresses arbitrary projects through platform-wide operator
      // authority and stays within the admin explorer routes.
      return {
        remoteTreeSource: (path) => ({
          async openConnection(args) {
            const stream =
              adminStream.adminProjectId === NULL_DURABLE_OBJECT_PROJECT_ID
                ? (await connectIterateSession()).streams.get(path)
                : (await connectItx(adminStream.adminProjectId)).streams.get(path);
            return stream.openConnection(args);
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
      onOpenPath(path) {
        setOpen(false);
        void navigate(linkOptionsForStreamPath(activeStream.projectSlug, path));
      },
    };
  }, [activeStream, adminStream, navigate]);

  if (activeStream == null || streamNavigator == null) {
    return (
      <ProjectPickerDialog
        open={open}
        onOpenChange={handleOpenChange}
        onPick={(project) => {
          if (inAdmin) {
            handleOpenChange(false);
            void navigate({
              to: "/admin/streams/$projectId",
              params: { projectId: project.id },
              search: {},
            });
            return;
          }
          setPickedProject(project);
        }}
      />
    );
  }

  return open ? (
    <Suspense fallback={<p role="status">Loading project navigation…</p>}>
      <CommandPaletteDialog
        open
        onOpenChange={handleOpenChange}
        currentPath={activeStream.streamPath}
        navigator={streamNavigator}
        scope={activeStream.projectId}
        // The admin lane browses through platform-wide operator authority, and its
        // `__null__` deployment namespace has no project DO to index — dialing
        // `projects.get("__null__")` would just retry forever. Admin gets the
        // tree; the live index is the app lane's.
        liveIndex={adminStream == null}
      />
    </Suspense>
  ) : null;
}

/**
 * The ⌘K first step outside any project: pick which project's agents and
 * streams to browse. The query is active only while this dialog is open.
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
  const { data: projects } = useIterateSessionQuery({
    key: ["projects"],
    query: (session) => session.projects.list(),
    enabled: open,
    staleTime: projectsListStaleTime,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Project navigation</DialogTitle>
          <DialogDescription>Pick a project to browse its agents and streams.</DialogDescription>
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
 * explorer routes and dials through platform-wide operator authority.
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
