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
        const users = await trpcClient.admin.findUsersByEstate.query({ estateId: input });
        const selection = prompt(
          `Select a user to impersonate:\n${users.map((u, i) => `${i + 1}. ${u.email} (${u.role})`).join("\n")}`,
        );
        input = users.find((u, i) => u.email === selection || i + 1 === Number(selection))?.userId;
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
      if (data?.user?.email) window.location.reload();
    },
  });

  return { unimpersonate, impersonate, ...impersonationInfo };
};
