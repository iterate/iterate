// /admin — the platform admin area. Everything under this layout talks to the
// platform through a ROOT itx handle: a Cap'n Web session on the global
// context (/api/itx), not oRPC. The handle only has global authority (access
// "all") when the request carries admin credentials — the admin-cookie bridge
// (POST /api/itx/admin-cookie with the admin API secret) sets those for the
// browser, since WebSockets cannot send Authorization headers. Until then the
// layout shows an unlock form instead of its children.

import { Suspense, useEffect, useState, type CSSProperties } from "react";
import { ClientOnly, createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  FolderKanbanIcon,
  RadioTowerIcon,
  ShieldIcon,
  SquareTerminalIcon,
  WaypointsIcon,
} from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
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
import { NULL_DURABLE_OBJECT_PROJECT_ID } from "~/domains/durable-object-names.ts";
import { reconnectItx, useItx } from "~/itx/itx-react.tsx";

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

type AdminAuthority =
  | { status: "checking" }
  // The WebSocket is up but the handle lacks global authority (no admin cookie
  // yet) — or the probe failed. Either way the fix is the same: unlock with the
  // admin API secret.
  | { status: "locked"; reason: string }
  | { status: "ready" };

function AdminGate() {
  // The admin handle is the global itx socket — the SAME connection the rest of
  // the tab uses (one browser itx primitive, one /api/itx route; see
  // ~/itx/itx-react.tsx). Its global authority comes from the admin cookie on the
  // WebSocket handshake, so unlock re-dials the socket
  // (reconnectItx) and useItx re-suspends here, re-running the probe — no
  // epoch, no private socket, no manual connect lifecycle.
  const itx = useItx();
  const [authority, setAuthority] = useState<AdminAuthority>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;
    setAuthority({ status: "checking" });
    // Probe global authority: itx.streams on a global handle throws unless the
    // connection authenticated as admin, so one cheap call tells us whether to
    // render the admin pages or the unlock form.
    void itx.streams
      .get("/")
      .runtimeState()
      .then(
        () => {
          if (!cancelled) setAuthority({ status: "ready" });
        },
        (error: unknown) => {
          if (!cancelled) {
            setAuthority({
              status: "locked",
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [itx]);

  if (authority.status === "checking") return <AdminConnecting />;
  if (authority.status === "locked") {
    // Unlock set the admin cookie; evict the pooled socket so useItx re-dials a
    // handshake that carries it (and re-runs this probe). The pool owns the
    // socket — we never close it here.
    return <AdminUnlockForm reason={authority.reason} onUnlocked={() => reconnectItx()} />;
  }
  // Children just call useItx() for the same global pooled handle — no admin
  // context to thread, and they only render here, under the authorized gate.
  return <Outlet />;
}

function AdminUnlockForm({ reason, onUnlocked }: { reason: string; onUnlocked: () => void }) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function unlock() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/itx/admin-cookie", {
        body: secret.trim(),
        credentials: "same-origin",
        headers: { "content-type": "text/plain" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(response.status === 401 ? "Wrong admin API secret." : response.statusText);
      }
      onUnlocked();
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : String(unlockError));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto mt-16 flex w-full max-w-md flex-col gap-5 px-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Admin access required</h1>
        <p className="text-sm text-muted-foreground">
          Paste the admin API secret for this deployment to set the admin cookie.
        </p>
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void unlock();
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="admin-api-secret">Admin API secret</FieldLabel>
            <Input
              id="admin-api-secret"
              type="password"
              placeholder="Secret"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <FieldDescription>{reason}</FieldDescription>
          </Field>
        </FieldGroup>
        <Button type="submit" disabled={submitting || secret.trim() === ""}>
          {submitting ? "Unlocking..." : "Unlock"}
        </Button>
      </form>
      <FieldError>{error}</FieldError>
    </div>
  );
}

function AdminSidebar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" tooltip="Iterate Admin" render={<Link to="/admin" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
                <ShieldIcon aria-hidden="true" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Iterate Admin</span>
                <span className="truncate text-xs text-sidebar-foreground/70">Platform tools</span>
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
                  isActive={pathname.startsWith(`/admin/streams/${NULL_DURABLE_OBJECT_PROJECT_ID}`)}
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
  );
}
