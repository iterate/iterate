import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/integrations/trpc/react.ts";

export function useAgents() {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.listAgents.queryOptions(),
    refetchInterval: 2000,
  });
}

export function useAgent(id: string) {
  const trpc = useTRPC();

  return useQuery({
    ...trpc.getAgent.queryOptions({ id }),
    enabled: !!id,
  });
}

export function useCreateAgent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation({
    ...trpc.createAgent.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [["listAgents"]] });
    },
  });
}

export function useDeleteAgent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation({
    ...trpc.deleteAgent.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [["listAgents"]] });
    },
  });
}
