import "@tanstack/react-start";
import type { QueryClient } from "@tanstack/react-query";

declare module "@tanstack/react-router" {
  interface RootRouteContext {
    queryClient: QueryClient;
  }
}
