import { Link, useMatchRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BookOpenText, KeyRound, Plus, TerminalSquareIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { LIST_RUNS_INPUT } from "~/lib/runs.ts";
import { orpc } from "~/orpc/client.ts";

export function AppSidebar() {
  const matchRoute = useMatchRoute();
  const runsQuery = useQuery({
    ...orpc.runs.list.queryOptions({ input: LIST_RUNS_INPUT }),
    staleTime: 30_000,
  });

  return (
    <Sidebar className="border-r-0">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/runs-v2-new" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground">
                C
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">codemode</span>
                <span className="truncate text-xs text-sidebar-foreground/70">dynamic workers</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Run</SidebarGroupLabel>
          <SidebarGroupAction render={<Link to="/runs-v2-new" />} title="New Run">
            <Plus />
            <span className="sr-only">New Run</span>
          </SidebarGroupAction>

          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/runs-v2-new" />}
                isActive={Boolean(matchRoute({ to: "/runs-v2-new" }))}
              >
                <Plus className="size-4 shrink-0" />
                <span>New Run</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/examples" />}
                isActive={Boolean(matchRoute({ to: "/examples" }))}
              >
                <BookOpenText className="size-4 shrink-0" />
                <span>Examples</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/secrets" />}
                isActive={Boolean(matchRoute({ to: "/secrets" }))}
              >
                <KeyRound className="size-4 shrink-0" />
                <span>Secrets</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>History</SidebarGroupLabel>
          <SidebarMenu>
            {runsQuery.data?.runs.map((run) => (
              <SidebarMenuItem key={run.id}>
                <SidebarMenuButton
                  render={<Link to="/runs/$runId" params={{ runId: run.id }} />}
                  isActive={Boolean(matchRoute({ to: "/runs/$runId", params: { runId: run.id } }))}
                  className="h-auto min-h-12 items-start py-2"
                >
                  <TerminalSquareIcon className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{run.codePreview}</div>
                    <div className="truncate text-xs text-sidebar-foreground/70">
                      {run.resultPreview}
                    </div>
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}

            {runsQuery.data && runsQuery.data.runs.length === 0 ? (
              <SidebarMenuItem>
                <span className="px-2 py-1 text-xs text-muted-foreground">No runs yet</span>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
