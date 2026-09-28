import type { ReactNode } from "react";
import type { Principal } from "iterate/principal";
import { AppShell, type AppShellProject } from "./app-shell.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./breadcrumb.tsx";

/** A project's page in an app that shows one project at a time (Notes, Voice): the shared
 *  `AppShell` with that project picked in its switcher, each project at `/projects/<slug>` under
 *  the page's `basePath`, and `<app> › <slug>` in the header. */
export function ProjectAppShell({
  app,
  projects,
  project,
  basePath = "",
  account,
  locationKey,
  nav,
  children,
}: {
  app: string;
  projects: AppShellProject[];
  project: AppShellProject;
  /** the path the page is served under when a project proxies the app (packages/ui/src/apps/base-path.ts) */
  basePath?: string;
  account: Principal;
  /** the router's current href — a change closes the phone's sidebar sheet */
  locationKey: string;
  /** the app's own navigation in the sidebar, its `SidebarGroup`s (`AppShell`'s `nav`, which ⌘K
   *  lists too) */
  nav?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AppShell
      app={app}
      projects={projects}
      activeProjectId={project.id}
      projectHref={(item) => `${basePath}/projects/${item.slug}`}
      header={
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem className="hidden md:inline-flex">{app}</BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:inline-flex" />
            <BreadcrumbItem>
              <BreadcrumbPage className="font-mono">{project.slug}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      }
      nav={nav}
      account={account}
      locationKey={locationKey}
    >
      {children}
    </AppShell>
  );
}
