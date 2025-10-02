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
      let input: string | null | undefined = prompt(
        "Enter an email, user id, or estate id to impersonate another user.",
      );

      if (input?.startsWith("est_")) {
        const owner = await trpcClient.admin.getEstateOwner.query({ estateId: input });
        input = owner.userId;
      }

      if (!input) return;

      const user = input.includes("@")
        ? await trpcClient.admin.findUserByEmail.query({ email: input })
        : { id: input };

      if (!user) return;
      const impersonateResult = await authClient.admin.impersonateUser({
        userId: user.id,
      });
      if (impersonateResult.error) throw impersonateResult.error; // todo: have better auth throw errors by default
      return impersonateResult.data;
    },
    onSuccess: (data) => {
      if (data?.user?.email) window.location.href = "/";
    },
  });

  return { unimpersonate, impersonate, ...impersonationInfo };
};
