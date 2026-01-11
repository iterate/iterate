import type { QueryClient } from "@tanstack/react-query";

import { trpcClient } from "./trpc-client.ts";
import { TRPCProvider } from "@/integrations/trpc/react.ts";

export function Provider({
  children,
  queryClient,
}: {
  children: React.ReactNode;
  queryClient: QueryClient;
}) {
  return (
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      {children}
    </TRPCProvider>
  );
}
