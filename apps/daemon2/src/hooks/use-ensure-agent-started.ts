import { useSuspenseQuery } from "@tanstack/react-query";

import { trpcClient } from "@/integrations/tanstack-query/trpc-client.ts";

export function useEnsureAgentStarted(slug: string) {
  useSuspenseQuery({
    queryKey: ["ensureAgentStarted", slug],
    queryFn: () => trpcClient.startAgent.mutate({ slug }),
    staleTime: Infinity,
  });
}
