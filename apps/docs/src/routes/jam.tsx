import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { withDocsProject } from "../lib/docs-client.ts";

/**
 * Start a jam: mint a scratch workspace on the config repo, seed its one
 * document, and land on the ordinary document view with the file tree
 * beside it. The URL you arrive at IS the jam — share it, paste it to an
 * agent. No jam is stored anywhere but as that workspace.
 */
export const Route = createFileRoute("/jam")({
  component: JamPage,
});

function JamPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // One jam per visit, even under StrictMode's double-run.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void withDocsProject((project) => project.createJam())
      .then(({ workspacePath, path }) =>
        navigate({ to: "/", replace: true, search: { workspace: workspacePath, path } }),
      )
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [navigate]);
  return (
    <div className="grid min-h-svh place-items-center text-sm text-muted-foreground">
      {error === null ? (
        <span className="flex items-center gap-2">
          <Spinner className="size-4" /> Starting a jam…
        </span>
      ) : (
        <span className="text-red-700">{error}</span>
      )}
    </div>
  );
}
