// A live state inside the context view's processors panel — the core reduce's under the name `core`,
// a hosted facet's under its own — one entry of the ONE `useIterateContext` result the page holds,
// rendered as YAML. Pure: the hook runs on the app's side of the boundary and packages/ui stays free
// of the SDK, so the page hands the panel this component per facet. The dash carries the same few
// lines.
import type { LiveStateResult } from "iterate/next/react";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";

export function LiveStateValue({ state }: { state: LiveStateResult }) {
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
