// /admin — the platform admin area. Everything under this layout talks to the
// platform through a ROOT itx handle: a Cap'n Web session on the global
// context (/api), not oRPC. The handle only has global authority (access
// "all") when the request carries a short-lived operator session. Operators
// mint those sessions from the Doppler-backed CLI; the platform admin secret
// is never entered into or stored by the browser.

import { Suspense, useEffect, useState, type CSSProperties } from "react";
import { ClientOnly, createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  FolderKanbanIcon,
  RadioTowerIcon,
  ShieldIcon,
  SquareTerminalIcon,
  WaypointsIcon,
} from "lucide-react";
import { Separator } from "@iterate-com/ui/components/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@iterate-com/ui/components/sidebar";
import { isItxTransportError, useIterateSession } from "iterate/react";
import { CloseMobileSidebarOnNavigate } from "~/components/close-mobile-sidebar-on-navigate.tsx";
import { GlobalCommandPalette } from "~/components/global-command-palette.tsx";
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/lib/stream-navigation.ts";

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <SidebarProvider
      className="h-svh"
      style={
        {
          "--sidebar-width": "17rem",
        } as CSSProperties
      }
    >
      <AdminSidebar />
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-vertical:h-4 data-vertical:self-auto"
            />
            <span className="text-sm font-medium">Admin</span>
          </div>
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* useItx never SSRs and suspends until connected — gate the admin
              handle behind ClientOnly + Suspense, then probe global authority. */}
          <ClientOnly fallback={<AdminConnecting />}>
            <Suspense fallback={<AdminConnecting />}>
              <AdminGate />
            </Suspense>
          </ClientOnly>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function AdminConnecting() {
  return (
    <div className="p-4 text-sm text-muted-foreground">Connecting to the root itx context...</div>
  );
}

type AdminAuthority = { status: "checking" } | { status: "locked" } | { status: "ready" };

function AdminGate() {
  // The admin handle is the itx SESSION — the SAME one socket the rest of the
  // tab uses (one browser itx primitive, one /api route; see
  // iterate/react). Its global authority comes from the operator cookie on
  // the WebSocket handshake. The CLI redemption flow loads this page only after
  // installing that cookie, so this component never handles admin material.
  const session = useIterateSession();
  const [authority, setAuthority] = useState<AdminAuthority>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;
    setAuthority({ status: "checking" });
    // Probe global authority: session.streams throws unless the connection
    // authenticated as admin, so one cheap call tells us whether to render the
    // admin pages or the unlock form.
    void session.streams
      .get("/")
      .runtimeState()
      .then(
        () => {
          if (!cancelled) setAuthority({ status: "ready" });
        },
        (error: unknown) => {
          if (cancelled) return;
          // A transport-shaped rejection is a reconnect blip, not a denied
          // operator: stay "checking" — the socket re-dials and the effect
          // re-runs on the fresh session (its identity is the dep). Only a real
          // authority rejection (session.streams throws for non-admins) locks.
          if (isItxTransportError(error)) {
            setAuthority({ status: "checking" });
            return;
          }
          console.error("admin authority probe failed", error);
          setAuthority({ status: "locked" });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (authority.status === "checking") return <AdminConnecting />;
  if (authority.status === "locked") return <AdminSessionRequired />;
  // Children just call useIterateSession() for the same one socket — no admin context
  // to thread, and they only render here, under the authorized gate. The ⌘K
  // stream switcher mounts here too: its admin tier reads the same session,
  // which only has authority once this gate has passed.
  return (
    <>
      <Outlet />
      <GlobalCommandPalette />
    </>
  );
}

function AdminSessionRequired() {
  return (
    <div className="mx-auto mt-16 flex w-full max-w-md flex-col gap-1 px-4">
      <h1 className="text-lg font-semibold">Platform operator access required</h1>
      <p className="text-sm text-muted-foreground">
        This browser has no active platform-wide operator session.
      </p>
    </div>
  );
}

function AdminSidebar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <>
      {/* Outside <Sidebar>: mobile Sheet remounts its children when opened. */}
      <CloseMobileSidebarOnNavigate />
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip="iterate admin" render={<Link to="/admin" />}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
                  <ShieldIcon aria-hidden="true" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">iterate admin</span>
                  <span className="truncate text-xs text-sidebar-foreground/70">
                    Platform tools
                  </span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Admin</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="Streams explorer"
                    isActive={pathname.startsWith("/admin/streams")}
                    render={<Link to="/admin/streams" />}
                  >
                    <WaypointsIcon aria-hidden="true" />
                    <span>Streams explorer</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="Projects"
                    isActive={pathname.startsWith("/admin/projects")}
                    render={<Link to="/admin/projects" />}
                  >
                    <FolderKanbanIcon aria-hidden="true" />
                    <span>Projects</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="Repl"
                    isActive={pathname.startsWith("/admin/repl")}
                    render={<Link to="/admin/repl" />}
                  >
                    <SquareTerminalIcon aria-hidden="true" />
                    <span>Repl</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Shortcuts</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="Global streams"
                    isActive={pathname.startsWith(
                      `/admin/streams/${NULL_DURABLE_OBJECT_PROJECT_ID}`,
                    )}
                    render={
                      <Link
                        to="/admin/streams/$projectId"
                        params={{ projectId: NULL_DURABLE_OBJECT_PROJECT_ID }}
                      />
                    }
                  >
                    <RadioTowerIcon aria-hidden="true" />
                    <span>Global streams</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
    </>
  );
}
