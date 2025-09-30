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
      const userIdOrEmail = prompt("user id or email to impersonate");
      if (!userIdOrEmail) return;
      const user = userIdOrEmail.includes("@")
        ? await trpcClient.admin.findUserByEmail.query({ email: userIdOrEmail })
        : { id: userIdOrEmail };
      if (!user) return;
      const impersonateResult = await authClient.admin.impersonateUser({
        userId: user.id,
      });
      if (impersonateResult.error) throw impersonateResult.error; // todo: have better auth throw errors by default
      return impersonateResult.data;
    },
    onSuccess: (data) => {
      if (data?.user?.email) window.location.reload();
    },
  });

  return { unimpersonate, impersonate, ...impersonationInfo };
};
