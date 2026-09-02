import { focusManager, QueryCache, QueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { reportTransportSuspicion } from "iterate/sdk/itx/react";
import { AppState, Platform } from "react-native";
import { SignInRequiredError } from "./auth.ts";
import { sessionKey } from "./session.ts";

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
// A dead sign-in is app-global, so handling it is too: any query that fails
// with SignInRequiredError drops the app back to the sign-in screen and
// invalidates the session read, rather than each screen catching it for
// itself. Redirecting from the async failure (not from render) matters —
// render-time navigation re-fires on every re-render while the error persists.
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (!(error instanceof SignInRequiredError)) return;
      void queryClient.invalidateQueries({ queryKey: sessionKey });
      router.replace("/");
    },
  }),
  defaultOptions: {
    // The shared itx keeper repairs its socket; one query retry lets an
    // in-flight read pick up the fresh generation without delaying real errors.
    queries: { retry: 1, staleTime: 15_000 },
  },
});
