import { focusManager, QueryClient } from "@tanstack/react-query";
import { reportTransportSuspicion } from "iterate/react";
import { AppState, Platform } from "react-native";

if (Platform.OS !== "web") {
  focusManager.setEventListener((setFocused) => {
    const subscription = AppState.addEventListener("change", (state) => {
      setFocused(state === "active");
      if (state === "active") reportTransportSuspicion();
    });
    return () => subscription.remove();
  });
}

// Module-level client shared by screens and iterate/react subscription sinks.
// _layout.tsx provides this exact instance.
export const queryClient = new QueryClient({
  defaultOptions: {
    // The shared itx keeper repairs its socket; one query retry lets an
    // in-flight read pick up the fresh generation without delaying real errors.
    queries: { retry: 1, staleTime: 15_000 },
  },
});
