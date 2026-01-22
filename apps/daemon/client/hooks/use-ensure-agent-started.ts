import { useSuspenseQuery } from "@tanstack/react-query";
import { orpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";

export function useEnsureAgentStarted(slug: string) {
  useSuspenseQuery({
    queryKey: ["ensureAgentStarted", slug],
    queryFn: () => orpcClient.startAgent({ slug }),
    staleTime: Infinity,
  });
}
