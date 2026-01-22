import { useSuspenseQuery } from "@tanstack/react-query";
import { orpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";

export function useEnsureTmuxSession(sessionName: string, command: string) {
  useSuspenseQuery({
    queryKey: ["ensureTmuxSession", sessionName],
    queryFn: () => orpcClient.ensureTmuxSession({ sessionName, command }),
    staleTime: Infinity,
  });
}
