// The sidebar, apps/os's app shell at this page's size: the project, its agents, a form that births
// one, and the account row with the theme switcher.
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { BotIcon, ChevronsUpDownIcon, LogOutIcon, PlusIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { IterateMark } from "@iterate-com/ui/components/iterate-mark";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { SidebarThemeSwitcher } from "@iterate-com/ui/components/sidebar-theme-switcher";
import { toast } from "@iterate-com/ui/components/sonner";

export function AgentsSidebar({
  projects,
  project,
  agents,
  agent,
  account,
  onCreate,
}: {
  projects: { id: string }[];
  project: string;
  agents: { path: string }[];
  agent: string | undefined;
  account: string;
  /** Births the agent at `/agents/<name>`; the page navigates to it once it exists. */
  onCreate: (name: string, systemPrompt: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setCreating(true);
    try {
      await onCreate(String(data.get("name")).trim(), String(data.get("prompt")).trim());
      form.reset();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {projects.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton size="lg" className="data-[popup-open]:bg-sidebar-accent" />
                  }
                >
                  <IterateMark className="size-8 shrink-0" />
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">Agents</span>
                    <span className="truncate text-xs text-muted-foreground">{project}</span>
                  </div>
                  <ChevronsUpDownIcon className="ml-auto size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-(--anchor-width) min-w-56">
                  {projects.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      render={<Link to="/agents" search={{ project: item.id }} />}
                    >
                      {item.id}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <SidebarMenuButton size="lg" render={<div />}>
                <IterateMark className="size-8 shrink-0" />
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Agents</span>
                  <span className="truncate text-xs text-muted-foreground">{project}</span>
                </div>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {agents.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">No agents yet.</p>
              ) : null}
              {agents.map((item) => (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    isActive={item.path === agent}
                    render={<Link to="/agents" search={{ project, agent: item.path }} />}
                  >
                    <BotIcon />
                    <span className="truncate">{item.path.replace(/^\/agents\//, "")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>New agent</SidebarGroupLabel>
          <SidebarGroupContent>
            <form onSubmit={create} className="px-2">
              <FieldGroup className="gap-3">
                <Field>
                  <FieldLabel htmlFor="new-agent-name" className="text-xs">
                    Name
                  </FieldLabel>
                  <Input
                    id="new-agent-name"
                    name="name"
                    placeholder="support"
                    pattern="[a-z0-9\-]+"
                    title="lowercase letters, digits and dashes"
                    required
                    className="h-8"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-agent-prompt" className="text-xs">
                    Instructions (optional)
                  </FieldLabel>
                  <Input
                    id="new-agent-prompt"
                    name="prompt"
                    placeholder="Be terse."
                    className="h-8"
                  />
                </Field>
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={creating}
                  className="self-start"
                >
                  <PlusIcon data-icon="inline-start" />
                  {creating ? "Creating…" : "Create"}
                </Button>
              </FieldGroup>
            </form>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarThemeSwitcher />
          <SidebarMenuItem>
            <form method="post" action="/.auth/logout">
              <SidebarMenuButton type="submit" tooltip="Log out">
                <LogOutIcon />
                <span className="truncate">{account}</span>
              </SidebarMenuButton>
            </form>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
