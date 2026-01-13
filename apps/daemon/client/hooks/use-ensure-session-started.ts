import { useSuspenseQuery } from "@tanstack/react-query";
import { trpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";

export function useEnsureSessionStarted(slug: string) {
  useSuspenseQuery({
    queryKey: ["ensureSessionStarted", slug],
    queryFn: () => trpcClient.startSession.mutate({ slug }),
    staleTime: Infinity,
  });
}
