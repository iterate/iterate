// One live state for the processors panel's `renderCoreState` / `renderLiveState` slots — the core
// reduce's under the name `core`, a hosted facet's under its own — rendered as YAML. The prop is
// structural so packages/ui stays free of the SDK: the app runs `useIterateContext` and passes each
// entry in.
import { SerializedObjectCodeBlock } from "../serialized-object-code-block.tsx";
import { Spinner } from "../spinner.tsx";

export function LiveStateValue({
  state,
}: {
  state: { status: string; value: unknown; error?: string };
}) {
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
