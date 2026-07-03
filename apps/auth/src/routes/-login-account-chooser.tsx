import type { ReactNode } from "react";
import { useState } from "react";
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
  const [showLoginActions, setShowLoginActions] = useState(false);

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
                isCurrent={isCurrent}
                isDisabled={isAccountActionPending}
                isBusy={
                  token !== null &&
                  setActiveSession.isPending &&
                  setActiveSession.variables === token
                }
                isRevoking={
                  token === null
                    ? signOutCurrentSession.isPending
                    : revokeSession.isPending && revokeSession.variables === token
                }
                onContinue={() => {
                  if (isCurrent || token === null) {
                    continueWithAccount();
                  } else {
                    setActiveSession.mutate(token);
                  }
                }}
                onSignOut={() => {
                  if (token === null) {
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

      {showLoginActions ? (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
          {children}
          <Button
            className="w-full"
            variant="ghost"
            disabled={isAccountActionPending}
            onClick={() => setShowLoginActions(false)}
          >
            Back to accounts
          </Button>
        </div>
      ) : (
        <Button
          className="w-full"
          variant="outline"
          disabled={isAccountActionPending}
          onClick={() => setShowLoginActions(true)}
        >
          Log in as someone else
        </Button>
      )}
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
  return (
    <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function AccountRow({
  user,
  isCurrent,
  isDisabled,
  isBusy,
  isRevoking,
  onContinue,
  onSignOut,
}: {
  user: LoginUser;
  isCurrent: boolean;
  isDisabled: boolean;
  isBusy: boolean;
  isRevoking: boolean;
  onContinue: () => void;
  onSignOut: () => void;
}) {
  const initials = getInitials(user.name ?? user.email);

  return (
    <div className="rounded-lg border bg-muted/30 p-3 sm:flex sm:items-center sm:gap-3">
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
        {isCurrent ? (
          <span className="shrink-0 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background">
            Current
          </span>
        ) : null}
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
