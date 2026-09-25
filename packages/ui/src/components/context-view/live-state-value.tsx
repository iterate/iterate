// One live state in the processors panel — the core reduce's under the name `core`, a hosted
// facet's under its own — rendered as YAML (ContextView renders every entry of its source's
// `liveState` with it).
import { SerializedObjectCodeBlock } from "../serialized-object-code-block.tsx";
import { Spinner } from "../spinner.tsx";
import type { LiveStateView } from "./types.tsx";

export function LiveStateValue({ state }: { state: LiveStateView }) {
  if (state.status === "error")
    return (
      <p data-type="error" className="text-xs text-destructive">
        Live state unavailable: {state.error}
      </p>
    );
  if (state.value === undefined)
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner /> Connecting…
      </p>
    );
  return <SerializedObjectCodeBlock data={state.value} initialFormat="yaml" showToggle={false} />;
}
