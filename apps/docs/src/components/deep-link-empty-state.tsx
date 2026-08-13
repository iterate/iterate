import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FileTextIcon, Loader2Icon, PlusIcon, TelescopeIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { withDocsProject } from "../lib/docs-client.ts";

/**
 * Docs home — the workspace picker. Pick (or type) a workspace path, then
 * one of its documents; or mint an ephemeral scratch workspace seeded with
 * a starter note. Deep links (?workspace=&path=) keep working unchanged;
 * this page exists for the human who arrives without one.
 */
export function DeepLinkEmptyState({ workspacePath }: { workspacePath?: string }) {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<{ path: string; createdAt: string }[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [chosen, setChosen] = useState(workspacePath ?? "");

  // The sidebar switcher navigates here with `?workspace=` (or clears it via
  // View all workspaces) while this page is already mounted — follow the
  // address both ways, don't keep the stale choice.
  useEffect(() => {
    setChosen(workspacePath ?? "");
  }, [workspacePath]);
  const [documents, setDocuments] = useState<string[] | null>(null);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!chosen.startsWith("/workspaces/")) {
      setDocuments(null);
      setDocumentsError(null);
      return;
    }
    let cancelled = false;
    setDocuments(null);
    setDocumentsError(null);
    // Debounced: a keystroke mid-path is not a workspace address yet —
    // fetching every prefix flashes "not found" errors and walks the tree
    // once per attempt. List-row clicks land here too, a beat later.
    const timer = setTimeout(() => {
      void withDocsProject((project) => project.documents(chosen))
        .then((list) => {
          if (!cancelled) setDocuments(list);
        })
        .catch((error: unknown) => {
          if (!cancelled) setDocumentsError(error instanceof Error ? error.message : String(error));
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chosen]);

  const open = (workspace: string, path: string) =>
    void navigate({ to: "/", search: { workspace, path } });

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
              Pick a workspace — every document lives in one. Agents share theirs through review
              links; New workspace mints you an ephemeral one.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Button onClick={createScratch} disabled={creating}>
              <PlusIcon aria-hidden className="size-4" />
              {creating ? "Creating…" : "New workspace"}
            </Button>
            {!!createError && (
              <p className="max-w-56 text-right text-xs text-red-700">{createError}</p>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="workspace-path" className="text-xs font-medium text-muted-foreground">
            Open a workspace path you know
          </label>
          <Input
            id="workspace-path"
            value={chosen}
            onChange={(event) => setChosen(event.currentTarget.value.trim())}
            placeholder="/workspaces/agents/…"
            spellCheck={false}
            className="mt-1 font-mono text-sm"
          />
          {!!documentsError && <p className="mt-1 text-xs text-red-700">{documentsError}</p>}
          {!!documents && (
            <ul className="mt-2 divide-y rounded-lg border bg-background">
              {documents.length === 0 ? (
                <li className="px-4 py-2.5 text-sm text-muted-foreground">
                  No documents in this workspace&rsquo;s own directory yet — agents create them, or
                  open a mount file through a deep link.
                </li>
              ) : (
                documents.map((path) => (
                  <li key={path}>
                    <button
                      type="button"
                      onClick={() => open(chosen, path)}
                      className="w-full px-4 py-2.5 text-left font-mono text-sm transition-colors hover:bg-muted/50"
                    >
                      {path}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>

        <section className="rounded-xl border bg-background shadow-xs">
          <div className="flex items-center gap-2.5 border-b px-5 py-4">
            <TelescopeIcon aria-hidden className="size-5 text-muted-foreground" />
            <h2 className="truncate text-sm font-semibold">All workspaces</h2>
          </div>
          {!workspaces ? (
            <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground">
              {!listError ? (
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
