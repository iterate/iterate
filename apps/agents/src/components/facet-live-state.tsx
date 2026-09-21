// A facet's live state inside the context view's processors panel: the SDK's `useLiveState` over the
// facet's `liveSnapshot()` door (the core reduce answers the same door under the name `core`),
// rendered as YAML. The hook lives on the app's side of the boundary — packages/ui stays free of the
// SDK — so the page hands the panel this component per facet. The dash carries the same few lines.
import { useLiveState, type ContextLogItx } from "iterate/next/react";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { Spinner } from "@iterate-com/ui/components/spinner";

type LiveStateItx = ContextLogItx & { invoke(call: string): Promise<unknown> };

export function FacetLiveState({ itx, name }: { itx: LiveStateItx | undefined; name: string }) {
  const live = useLiveState<unknown>(itx, {
    key: name,
    door: async () => {
      const seed = await itx!.invoke(`itx.facets.get('${name}').liveSnapshot()`);
      return seed as { rev: number; state: unknown }; // the engine's own `{ rev, state }` seed
    },
  });
  if (live.status === "error")
    return <p className="text-xs text-destructive">Live state unavailable: {live.error}</p>;
  if (live.value === undefined)
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner /> Connecting…
      </p>
    );
  return <SerializedObjectCodeBlock data={live.value} initialFormat="yaml" showToggle={false} />;
}
