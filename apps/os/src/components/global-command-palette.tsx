import { lazy, Suspense, useEffect, useState } from "react";
import { useMatch, useMatches, useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@iterate-com/ui/components/dialog";
import { useIterateSessionQuery } from "iterate/sdk/itx/react";
import { OPEN_GLOBAL_COMMAND_PALETTE_EVENT } from "~/components/global-command-palette-events.ts";
import { activeStreamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { projectsListStaleTime } from "~/lib/projects-query.ts";
import { streamPathFromSplatOrRoot } from "~/lib/stream-links.ts";
import { linkOptionsForAdminStreamPath, linkOptionsForStreamPath } from "~/lib/stream-routes.ts";

const ProjectCommandPaletteDialog = lazy(() =>
  import("./command-palette-dialog.tsx").then((module) => ({
    default: module.ProjectCommandPaletteDialog,
  })),
);
const AdminStreamIndexDialog = lazy(() =>
  import("./command-palette-dialog.tsx").then((module) => ({
    default: module.AdminStreamIndexDialog,
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
  const adminProjectId = useMatch({
    from: "/admin/streams/$projectId",
    shouldThrow: false,
    select: (match) => match.params.projectId,
  });
  const adminSplat = useMatch({
    from: "/admin/streams/$projectId/$",
    shouldThrow: false,
    select: (match) => match.params._splat,
  });
  const project = useMatch({
    from: "/_app/projects/$projectSlug",
    shouldThrow: false,
    select: (match) => match.context.project,
  });
  const adminStream = !adminProjectId
    ? null
    : { projectId: adminProjectId, streamPath: streamPathFromSplatOrRoot(adminSplat) };
  // Under /admin but before a project is chosen (the /admin/streams picker
  // page), ⌘K must stay in the admin world: picking a project opens that
  // project's admin explorer instead of dialing the org-scoped app flow.
  const inAdmin = matches.some((match) => match.routeId.startsWith("/admin"));
  const streamBreadcrumb = activeStreamBreadcrumb(matches);
  const routeStream =
    streamBreadcrumb ??
    (!project ? null : { projectId: project.id, projectSlug: project.slug, streamPath: "/" });
  const activeStream =
    routeStream ??
    (pickedProject
      ? { projectId: pickedProject.id, projectSlug: pickedProject.slug, streamPath: "/" }
      : null);

  // Close on any navigation that swaps the stream context out from under an
  // open dialog (back button, links outside the dialog): the tree being shown
  // belongs to the page it was opened on. The palette's own navigations
  // already close it before routing.
  const routeStreamKey = !adminStream
    ? routeStream && `${routeStream.projectId}:${routeStream.streamPath}`
    : `admin:${adminStream.projectId}:${adminStream.streamPath}`;
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

  if (adminStream) {
    return open ? (
      <Suspense fallback={<p role="status">Loading stream navigation…</p>}>
        <AdminStreamIndexDialog
          currentPath={adminStream.streamPath}
          onOpenChange={handleOpenChange}
          onOpenPath={(path) => {
            void navigate(linkOptionsForAdminStreamPath(adminStream.projectId, path));
          }}
          projectId={adminStream.projectId}
        />
      </Suspense>
    ) : null;
  }

  if (!activeStream) {
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
      <ProjectCommandPaletteDialog
        onOpenChange={handleOpenChange}
        currentPath={activeStream.streamPath}
        onOpenPath={(path) => {
          void navigate(linkOptionsForStreamPath(activeStream.projectSlug, path));
        }}
        projectId={activeStream.projectId}
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
          {!projects ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading projects…</p>
          ) : !projects.length ? (
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
