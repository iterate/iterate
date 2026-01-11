import { useMutation } from "@tanstack/react-query";

import { trpcClient } from "@/integrations/tanstack-query/trpc-client.ts";

export function useEnsureTmuxSession(sessionName: string, command: string) {
  const mutation = useMutation({
    mutationFn: () => trpcClient.ensureTmuxSession.mutate({ sessionName, command }),
  });

  if (!mutation.isSuccess && !mutation.isPending && !mutation.isError) {
    mutation.mutate();
  }

  return {
    isReady: mutation.isSuccess,
    isLoading: mutation.isPending,
    error: mutation.error,
  };
}
