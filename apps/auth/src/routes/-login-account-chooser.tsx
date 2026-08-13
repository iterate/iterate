import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";
import { authClient } from "../utils/auth-client.ts";
import { getInitials } from "../utils/initials.ts";

export type LoginUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
};

type DeviceSession = Awaited<ReturnType<typeof authClient.multiSession.listDeviceSessions>>[number];

const DEVICE_SESSIONS_QUERY_KEY = ["better-auth", "multi-session", "device-sessions"] as const;

export function AccountChooser({
  children,
  currentUser,
  continueWithAccount,
  refreshCurrentPage,
}: {
  children: ReactNode;
  currentUser: LoginUser;
  continueWithAccount: () => void;
  refreshCurrentPage: () => void;
}) {
  const queryClient = useQueryClient();

  const deviceSessionsQuery = useQuery({
    queryKey: DEVICE_SESSIONS_QUERY_KEY,
    queryFn: () => authClient.multiSession.listDeviceSessions(),
  });

  const setActiveSession = useMutation({
    mutationFn: (sessionToken: string) => authClient.multiSession.setActive({ sessionToken }),
    onSuccess: continueWithAccount,
    onError: (error: Error) => {
      toast.error(error.message || "Failed to switch account");
    },
  });

  const revokeSession = useMutation({
    mutationFn: (sessionToken: string) => authClient.multiSession.revoke({ sessionToken }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: DEVICE_SESSIONS_QUERY_KEY });
      refreshCurrentPage();
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to sign out account");
    },
  });

  const signOutCurrentSession = useMutation({
    mutationFn: () => authClient.signOut(),
    onSuccess: refreshCurrentPage,
    onError: (error: Error) => {
      toast.error(error.message || "Failed to sign out account");
    },
  });

  const isAccountActionPending =
    revokeSession.isPending || signOutCurrentSession.isPending || setActiveSession.isPending;
  const accounts = deviceSessionsQuery.isPending
    ? []
    : getAccountRows({ currentUser, sessions: deviceSessionsQuery.data ?? [] });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {deviceSessionsQuery.isPending ? (
          <AccountStateMessage>Loading accounts...</AccountStateMessage>
        ) : (
          accounts.map((account) => {
            const isCurrent = account.user.id === currentUser.id;
            const token = account.token;
            return (
              <AccountRow
                key={token ?? account.user.id}
                user={account.user}
                isDisabled={isAccountActionPending}
                isBusy={
                  !!token && setActiveSession.isPending && setActiveSession.variables === token
                }
                isRevoking={
                  token
                    ? revokeSession.isPending && revokeSession.variables === token
                    : signOutCurrentSession.isPending
                }
                onContinue={() => {
                  if (isCurrent || !token) {
                    continueWithAccount();
                  } else {
                    setActiveSession.mutate(token);
                  }
                }}
                onSignOut={() => {
                  if (!token) {
                    signOutCurrentSession.mutate();
                  } else {
                    revokeSession.mutate(token);
                  }
                }}
              />
            );
          })
        )}
      </div>

      <div className="space-y-3 pt-2">{children}</div>
    </div>
  );
}

function getAccountRows({
  currentUser,
  sessions,
}: {
  currentUser: LoginUser;
  sessions: DeviceSession[];
}): Array<{ token: string | null; user: LoginUser }> {
  const accounts = sessions.map((session) => ({
    token: session.session.token,
    user: toLoginUser(session.user),
  }));

  return accounts.some((account) => account.user.id === currentUser.id)
    ? accounts
    : [{ token: null, user: currentUser }, ...accounts];
}

function toLoginUser(user: DeviceSession["user"]): LoginUser {
  return {
    id: user.id,
    name: user.name ?? null,
    email: user.email,
    image: user.image ?? null,
  };
}

function AccountStateMessage({ children }: { children: ReactNode }) {
  return <div className="py-2 text-sm text-muted-foreground">{children}</div>;
}

function AccountRow({
  user,
  isDisabled,
  isBusy,
  isRevoking,
  onContinue,
  onSignOut,
}: {
  user: LoginUser;
  isDisabled: boolean;
  isBusy: boolean;
  isRevoking: boolean;
  onContinue: () => void;
  onSignOut: () => void;
}) {
  const initials = getInitials(user.name ?? user.email);

  return (
    <div className="py-2 sm:flex sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar>
          {user.image && <AvatarImage src={user.image} alt={user.name ?? user.email} />}
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          disabled={isDisabled}
          onClick={onContinue}
        >
          <span className="block truncate text-sm font-medium">{user.name ?? "User"}</span>
          <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:mt-0 sm:flex sm:shrink-0 sm:items-center">
        <Button size="sm" className="w-full" disabled={isDisabled} onClick={onContinue}>
          {isBusy ? "Switching..." : "Continue"}
        </Button>
        <Button
          className="w-full"
          variant="ghost"
          size="sm"
          disabled={isDisabled}
          onClick={onSignOut}
        >
          {isRevoking ? "Signing out..." : "Sign out"}
        </Button>
      </div>
    </div>
  );
}
