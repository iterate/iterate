import { useMutation, useQuery } from "@tanstack/react-query";
import { authClient } from "../lib/auth-client.ts";
import { useTRPC, useTRPCClient } from "../lib/trpc.ts";

export const useImpersonation = () => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const { data: impersonationInfo } = useQuery(trpc.admin.impersonationInfo.queryOptions());
  const unimpersonate = useMutation({
    mutationFn: () => authClient.admin.stopImpersonating(),
    onSuccess: () => window.location.reload(),
  });
  const impersonate = useMutation({
    mutationFn: async () => {
      const input = prompt("Enter an email, user id, or estate id to impersonate another user.");

      let userId: string | undefined;
      if (input?.startsWith("est_")) {
        const owner = await trpcClient.admin.getEstateOwner.query({ estateId: input });
        userId = owner.userId;
      } else if (input?.includes("@")) {
        const user = await trpcClient.admin.findUserByEmail.query({ email: input });
        userId = user?.id;
      } else if (input) {
        userId = input;
      }

      if (!userId) return;
      const impersonateResult = await authClient.admin.impersonateUser({ userId });

      if (impersonateResult.error) throw impersonateResult.error; // todo: have better auth throw errors by default
      return impersonateResult.data;
    },
    onSuccess: (data) => {
      if (data?.user?.email) window.location.href = "/";
    },
  });

  return { unimpersonate, impersonate, ...impersonationInfo };
};
