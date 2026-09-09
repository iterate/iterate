import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { cn } from "@iterate-com/ui/lib/utils";
import { withDocsProject } from "../lib/docs-client.ts";
import { newWorkspaceName, workspacePathForName } from "../lib/workspace-names.ts";

/**
 * One input, pre-filled with three random words, and a Create button. The
 * name becomes the workspace's path under /workspaces/; the workspace is
 * created on the platform (every project repo mounted) and handed back.
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
  // form, and a name drawn during SSR never matches the client's draw (React
  // hydration error #418 — after which a click lands on an un-hydrated form
  // and submits it natively). Server render and hydration show an empty,
  // disabled form; the client's own draw appears right after.
  // A store that never changes: hydration is its only "event".
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [draw, setName] = useState(() => newWorkspaceName());
  const name = hydrated ? draw : "";
  // Focus on mount when asked (the sidebar item just opened the form) — an
  // effect, not the autoFocus attribute, which jsx-a11y warns against.
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (focusOnMount) inputRef.current?.select();
  }, [focusOnMount]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = workspacePathForName(name);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (path === null || creating) return;
    setCreating(true);
    setError(null);
    void withDocsProject((project) => project.createWorkspace({ name }))
      .then(({ workspacePath }) => onCreated(workspacePath))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setCreating(false));
  };

  return (
    <form onSubmit={submit} className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex gap-1.5">
        <Input
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          aria-label="Workspace name"
          placeholder="apple-cow-hat"
          spellCheck={false}
          ref={inputRef}
          className="h-8 font-mono text-xs"
        />
        <Button type="submit" size="sm" className="h-8" disabled={path === null || creating}>
          {creating ? "Creating…" : "Create"}
        </Button>
      </div>
      <p className="truncate font-mono text-[11px] text-muted-foreground" title={path ?? undefined}>
        {path ?? "letters, digits, dots, dashes; segments with /"}
      </p>
      {error !== null && <p className="text-xs text-red-700">{error}</p>}
    </form>
  );
}
