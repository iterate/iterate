"use client";
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
      const email = prompt("email to impersonate");
      if (!email) return;
      const user = await trpcClient.admin.findUserByEmail.query({ email });
      if (!user) return;
      const impersonateResult = await authClient.admin.impersonateUser({
        userId: user.id,
      });
      if (impersonateResult.error) throw impersonateResult.error; // todo: have better auth throw errors
      return impersonateResult.data;
    },
    onSuccess: () => window.location.reload(),
  });

  return { unimpersonate, impersonate, ...impersonationInfo };
};

// export const Impersonate = () => {
//   const { isImpersonating, unimpersonate, impersonate, checkAuth } = useImpersonation();
//   return (
//     <div className="flex flex-row gap-2 p-2">
//       {isImpersonating && (
//         <Button onClick={() => unimpersonate.mutate()}>stop impersonating</Button>
//       )}
//       {checkAuth.data?.message === "admin" && !isImpersonating && (
//         <Button disabled={isImpersonating} onClick={() => impersonate.mutate()}>
//           impersonate {impersonate.status.replace("idle", "")} {impersonate.data?.user?.email || ""}
//         </Button>
//       )}
//     </div>
//   );
// };
