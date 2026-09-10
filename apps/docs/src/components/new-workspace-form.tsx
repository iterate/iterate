import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { cn } from "@iterate-com/ui/lib/utils";
import { withDocsProject } from "../lib/docs-client.ts";
import { newWorkspacePath } from "../lib/workspace-names.ts";

/**
 * One input holding the workspace's path, pre-filled with a three-word
 * suggestion under /agents/, and a Create button. The workspace is created
 * on the platform (every project repo mounted) at exactly that path, which
 * is also the path of the agent that shares it.
 */
export function NewWorkspaceForm({
  onCreated,
  focusOnMount,
  className,
}: {
  onCreated: (workspacePath: string) => void;
  focusOnMount?: boolean;
  className?: string;
}) {
  // The suggestion shows on the client only: the home server-renders this
  // form, and a path drawn during SSR never matches the client's draw (React
  // hydration error #418 — after which a click lands on an un-hydrated form
  // and submits it natively). Server render and hydration show an empty,
  // disabled form; the client's own draw appears right after.
  // A store that never changes: hydration is its only "event".
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [draw, setPath] = useState(() => newWorkspacePath());
  const path = hydrated ? draw : "";
  // Focus on mount when asked (the sidebar item just opened the form) — an
  // effect, not the autoFocus attribute, which jsx-a11y warns against.
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (focusOnMount) inputRef.current?.select();
  }, [focusOnMount]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = path.startsWith("/agents/") && path.length > "/agents/".length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canCreate || creating) return;
    setCreating(true);
    setError(null);
    void withDocsProject((project) => project.createWorkspace({ path: path.trim() }))
      .then(({ workspacePath }) => onCreated(workspacePath))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setCreating(false));
  };

  return (
    <form onSubmit={submit} className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Input
        value={path}
        onChange={(event) => setPath(event.currentTarget.value)}
        aria-label="Workspace path"
        placeholder="/agents/apple-cow-hat"
        spellCheck={false}
        ref={inputRef}
        className="h-8 w-full min-w-0 font-mono text-xs"
      />
      <p className="truncate font-mono text-[11px] text-muted-foreground">
        /agents/…; lowercase letters, digits, dashes
      </p>
      {error !== null && <p className="text-xs text-red-700">{error}</p>}
      <Button type="submit" size="sm" className="h-8 self-end" disabled={!canCreate || creating}>
        {creating ? "Creating…" : "Create"}
      </Button>
    </form>
  );
}
