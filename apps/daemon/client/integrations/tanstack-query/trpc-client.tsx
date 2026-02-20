import type { TRPCClient } from "@trpc/client";
import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { AppRouter } from "@server/trpc/app-router.ts";

const context = createTRPCContext<AppRouter>();

// Wrapper to avoid TS2742 "type cannot be named" issue with re-exported context provider
export function TRPCProvider(props: {
  children: React.ReactNode;
  queryClient: QueryClient;
  trpcClient: TRPCClient<AppRouter>;
}) {
  return <context.TRPCProvider {...props} />;
}
// eslint-disable-next-line react-refresh/only-export-components -- Context exports are intentionally grouped with trpcClient
export const useTRPC = context.useTRPC;

// eslint-disable-next-line react-refresh/only-export-components -- trpcClient is intentionally exported alongside components for centralized tRPC configuration
export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchStreamLink({
      url: "api/trpc",
      methodOverride: "POST",
    }),
  ],
});
