// The signed-in shell: authenticate once with the `admin` scope (the SDK client; a missing session
// leaves for the issuer's login), read the projects this session reaches — every project on the
// platform, for an admin —
// and frame every child in the shared `AppShell` (packages/ui), the frame every client app uses.
import {
  createFileRoute,
  Link,
  Outlet,
  useMatch,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { FolderKanban, Globe, Users } from "lucide-react";
import { createIterateClient } from "iterate/app";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import { usePosthogIdentity } from "@iterate-com/ui/components/posthog";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { adminScopes } from "../scopes.ts";

const iterate = createIterateClient({ scopes: adminScopes });

export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href),
  loader: async ({ context }) => ({ projects: await context.api.projects.list() }),
  component: Shell,
});

function Shell() {
  const { info } = Route.useRouteContext();
  const { projects } = Route.useLoaderData();
  const router = useRouter();
  const href = useRouterState({ select: (state) => state.location.href });
  const slug = useMatch({ from: "/_auth/projects/$slug/$", shouldThrow: false })?.params.slug;
  const active = projects.find((project) => project.slug === slug);
  usePosthogIdentity(info.principal);
  return (
    <AppShell
      app="iterate"
      projects={projects.map((project) => ({ id: project.id, slug: project.slug }))}
      activeProjectId={active?.id || null}
      projectHref={(project) => `/projects/${project.slug}`}
      onNavigate={(to, event) => {
        event.preventDefault();
        void router.navigate({ href: to });
      }}
      nav={
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Projects" render={<Link to="/projects" />}>
                  <FolderKanban />
                  <span>Projects</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Users" render={<Link to="/users" />}>
                  <Users />
                  <span>Users</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Global"
                  render={<Link to="/global/$" params={{ _splat: "" }} />}
                >
                  <Globe />
                  <span>Global</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      }
      account={info.principal}
      locationKey={href}
    >
      <Outlet />
    </AppShell>
  );
}
