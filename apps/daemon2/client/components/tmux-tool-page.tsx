import { useSuspenseQuery } from "@tanstack/react-query";
import { trpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";

export function useEnsureTmuxSession(sessionName: string, command: string) {
  useSuspenseQuery({
    queryKey: ["ensureTmuxSession", sessionName],
    queryFn: () => trpcClient.ensureTmuxSession.mutate({ sessionName, command }),
    staleTime: Infinity,
  });
}
