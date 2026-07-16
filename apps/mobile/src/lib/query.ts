import { QueryClient } from "@tanstack/react-query";

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
