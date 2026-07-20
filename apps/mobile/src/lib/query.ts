import { focusManager, QueryClient } from "@tanstack/react-query";
import { AppState, Platform } from "react-native";

if (Platform.OS !== "web") {
  focusManager.setEventListener((setFocused) => {
    const subscription = AppState.addEventListener("change", (state) => {
      setFocused(state === "active");
    });
    return () => subscription.remove();
  });
}

// Module-level client so non-React code (the live stream subscription in
// live-thread.ts) can push server-sent events into the same cache the screens
// read from. _layout.tsx provides this exact instance.
export const queryClient = new QueryClient({
  defaultOptions: {
    // itx RPC calls fail hard when a socket dies; one retry after
    // resetItxSession is the recovery path, more just delays the error UI.
    queries: { retry: 1, staleTime: 15_000 },
  },
});
