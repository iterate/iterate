import { Badge } from "@iterate-com/ui/components/badge";
import type { SandboxProcessorState } from "~/domains/sandboxes/sandbox-processor-contract.ts";

export function SandboxStatusBadge({
  error,
  state,
}: {
  error?: string;
  state: SandboxProcessorState | undefined;
}) {
  if (error) {
    return (
      <Badge variant="destructive" title={error}>
        Unavailable
      </Badge>
    );
  }
  if (!state) {
    return (
      <Badge variant="secondary" data-spinner="true">
        Loading…
      </Badge>
    );
  }
  if (state.status === "destroyed") return <Badge variant="destructive">Destroyed</Badge>;
  if (state.running) return <Badge>Running</Badge>;
  if (!state.status) return <Badge variant="outline">Unknown</Badge>;
  return <Badge variant="secondary">Stopped</Badge>;
}
