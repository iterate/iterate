import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar.tsx";
import { AppSidebar } from "@/components/app-sidebar.tsx";
import { AppHeader } from "@/components/app-header.tsx";
import { RawModeProvider } from "@/hooks/raw-mode-provider.tsx";
import {
  useStreamReducer,
  registryReducer,
  API_URL,
  type AgentInfo,
  type RegistryEvent,
} from "@/hooks/use-stream-reducer.tsx";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const params = useParams({ strict: false });
  const agentId = "agentId" in params ? (params.agentId as string) : undefined;

  const { data: agents } = useStreamReducer<AgentInfo[], RegistryEvent>(
    `${API_URL}/agents/__registry__`,
    registryReducer,
    [],
  );

  return (
    <RawModeProvider>
      <SidebarProvider defaultOpen={false}>
        <AppSidebar agents={agents} />
        <SidebarInset className="max-h-svh">
          <AppHeader agentId={agentId} />
          <div className="flex-1 min-h-0">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </RawModeProvider>
  );
}
