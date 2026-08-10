import { focusManager, QueryClient } from "@tanstack/react-query";
import { reportTransportSuspicion } from "iterate/sdk/itx/react";
import { AppState, Platform } from "react-native";
import { logEvent } from "./session-log.ts";

if (Platform.OS !== "web") {
  focusManager.setEventListener((setFocused) => {
    const subscription = AppState.addEventListener("change", (state) => {
      setFocused(state === "active");
      if (state === "active") reportTransportSuspicion();
    });
    return () => subscription.remove();
  });
}

// Module-level client shared by screens and iterate/sdk/itx/react subscription sinks.
// _layout.tsx provides this exact instance.
export const queryClient = new QueryClient({
  defaultOptions: {
    // The shared itx keeper repairs its socket; one query retry lets an
    // in-flight read pick up the fresh generation without delaying real errors.
    queries: { retry: 1, staleTime: 15_000 },
  },
});

// Nearly every RPC the app makes rides a query or mutation, so the cache
// notify streams are the one seam that sees them all fail — feed the session
// log's rpc-failed trail from here instead of instrumenting every callsite.
queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") {
    logEvent("events.iterate.com/mobile/query-failed", {
      queryKey: event.query.queryKey,
      message: String(event.action.error),
    });
  }
});
queryClient.getMutationCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") {
    logEvent("events.iterate.com/mobile/mutation-failed", {
      mutationKey: event.mutation.options.mutationKey ?? null,
      message: String(event.action.error),
    });
  }
});
