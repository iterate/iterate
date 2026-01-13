import { useSuspenseQuery } from "@tanstack/react-query";
import { trpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";

export function useEnsureTmuxSession(params: { sessionName: string; command: string }) {
  useSuspenseQuery({
    queryKey: ["ensureTmuxSession", params.sessionName],
    queryFn: () => trpcClient.ensureTmuxSession.mutate(params),
    staleTime: Infinity,
  });
}
