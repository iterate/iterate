// Admin home: the events in the global namespace's root ("/") stream, read
// through the layout's root itx handle — itx.streams on a global admin handle
// targets the "global" stream namespace (see itx/handle.ts).

import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { StreamEvent } from "@iterate-com/streams/shared/event";
import { Button } from "@iterate-com/ui/components/button";
import { useAdminItx } from "~/lib/admin-itx.ts";

export const Route = createFileRoute("/admin/")({
  component: GlobalStreamPage,
});

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; events: StreamEvent[] };

function GlobalStreamPage() {
  const itx = useAdminItx();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const events = (await itx.streams.get("/").read({})) as StreamEvent[];
      setState({ status: "loaded", events });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [itx]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">
          Global stream <code className="rounded bg-muted px-1.5 py-0.5 text-sm">global:/</code>
        </h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={state.status === "loading"}
        >
          Refresh
        </Button>
        {state.status === "loaded" && (
          <span className="text-sm text-muted-foreground">
            {state.events.length} event{state.events.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {state.status === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}
      {state.status === "error" && <p className="text-sm text-destructive">{state.message}</p>}
      {state.status === "loaded" && state.events.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No events yet. Anything appended to the <code>/</code> stream in the <code>global</code>{" "}
          namespace shows up here.
        </p>
      )}
      {state.status === "loaded" && state.events.length > 0 && (
        <table className="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="w-20 py-2 pr-4 font-medium">Offset</th>
              <th className="w-56 py-2 pr-4 font-medium">Type</th>
              <th className="w-44 py-2 pr-4 font-medium">Created</th>
              <th className="py-2 font-medium">Payload</th>
            </tr>
          </thead>
          <tbody>
            {state.events.map((event) => (
              <tr key={event.offset} className="border-b align-top">
                <td className="py-2 pr-4 font-mono">{event.offset}</td>
                <td className="py-2 pr-4 font-mono break-words">{event.type}</td>
                <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">
                  {new Date(event.createdAt).toLocaleString()}
                </td>
                <td className="py-2">
                  <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
                    {JSON.stringify(event.payload ?? null, null, 2)}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
