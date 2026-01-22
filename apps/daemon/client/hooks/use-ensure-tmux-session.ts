import { useSuspenseQuery } from "@tanstack/react-query";
import { orpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";

export function useEnsureTmuxSession(params: { sessionName: string; command: string }) {
  useSuspenseQuery({
    queryKey: ["ensureTmuxSession", params.sessionName],
    queryFn: () => orpcClient.ensureTmuxSession(params),
    staleTime: Infinity,
  });
}
