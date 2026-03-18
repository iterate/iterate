import { ClientOnly, Outlet, createFileRoute, useRouter } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { AppSidebar } from "@/frontend/components/app-sidebar.tsx";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const router = useRouter();

  // In Start SPA mode, the built shell prerenders the root and swaps matched
  // route content for the pending fallback. We still keep this explicit shell
  // branch so the shared app chrome doesn't render during shell generation.
  //
  // First-party docs:
  // - SPA mode:
  //   https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode
  if (router.isShell()) {
    return <div className="min-h-screen bg-background" />;
  }

  return (
    <SidebarProvider defaultOpen={true}>
      <AppSidebar />
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center border-b px-3">
          <SidebarTrigger />
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-auto">
          {/* Route loaders/components in Start are isomorphic by default, so keep
              the nested app content behind ClientOnly to avoid browser-only route
              code executing during server-side shell/SSR paths.

              First-party docs:
              - Execution model:
                https://tanstack.com/start/latest/docs/framework/react/guide/execution-model
              - ClientOnly:
                https://tanstack.com/start/latest/docs/framework/react/guide/execution-model#client-only-execution
          */}
          <ClientOnly fallback={<div className="flex-1 bg-background" />}>
            <Outlet />
          </ClientOnly>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
