import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FileTextIcon, Loader2Icon, PlusIcon, TelescopeIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { withDocsProject } from "../lib/docs-client.ts";

/**
 * Docs home — the workspace picker: every workspace of the project (agents'
 * included), a path you know, or a fresh scratch workspace seeded with a
 * starter note. Opening one lands on its file tree; deep links
 * (?workspace=&path=) keep working unchanged.
 */
export function DeepLinkEmptyState() {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<{ path: string; createdAt: string }[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [chosen, setChosen] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void withDocsProject((project) => project.workspaces())
      .then((list) => {
        if (!cancelled) setWorkspaces(list);
      })
      .catch((error: unknown) => {
        if (!cancelled) setListError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const open = (workspace: string, path: string | null) =>
    void navigate({ to: "/", search: path === null ? { workspace } : { workspace, path } });

  const createScratch = () => {
    setCreating(true);
    setCreateError(null);
    void withDocsProject((project) => project.createWorkspace())
      .then(({ workspacePath, path }) => open(workspacePath, path))
      .catch((error: unknown) => {
        setCreateError(error instanceof Error ? error.message : String(error));
        setCreating(false);
      });
  };

  return (
    <div className="relative min-h-svh bg-muted/20 px-6 py-10">
      <SidebarTrigger className="absolute top-3 left-3 md:hidden" />
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-foreground text-background">
              <FileTextIcon aria-hidden className="size-5" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Workspaces</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Every file lives in a workspace: every project repo mounted under repos/, the
              workspace&rsquo;s own files beside them. Agents have one each; New workspace mints you
              an ephemeral one.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Button onClick={createScratch} disabled={creating}>
              <PlusIcon aria-hidden className="size-4" />
              {creating ? "Creating…" : "New workspace"}
            </Button>
            {createError !== null && (
              <p className="max-w-56 text-right text-xs text-red-700">{createError}</p>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="workspace-path" className="text-xs font-medium text-muted-foreground">
            Open a workspace path you know
          </label>
          <form
            className="mt-1 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (chosen.startsWith("/workspaces/")) open(chosen, null);
            }}
          >
            <Input
              id="workspace-path"
              value={chosen}
              onChange={(event) => setChosen(event.currentTarget.value.trim())}
              placeholder="/workspaces/agents/…"
              spellCheck={false}
              className="font-mono text-sm"
            />
            <Button type="submit" variant="outline" disabled={!chosen.startsWith("/workspaces/")}>
              Open
            </Button>
          </form>
        </div>

        <section className="rounded-xl border bg-background shadow-xs">
          <div className="flex items-center gap-2.5 border-b px-5 py-4">
            <TelescopeIcon aria-hidden className="size-5 text-muted-foreground" />
            <h2 className="truncate text-sm font-semibold">All workspaces</h2>
          </div>
          {workspaces === null ? (
            <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground">
              {listError === null ? (
                <>
                  <Loader2Icon aria-hidden className="size-4 animate-spin" /> Loading…
                </>
              ) : (
                listError
              )}
            </p>
          ) : (
            <ul className="divide-y">
              {workspaces.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => void navigate({ to: "/", search: { workspace: entry.path } })}
                    className="w-full px-5 py-3 text-left font-mono text-sm transition-colors hover:bg-muted/50"
                  >
                    {entry.path}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
