// /activity — the person's own record: everything that happened on their account context
// (`session.user`, the global `/users/<id>`): sign-ins, tokens minted and ended, consents approved —
// the context view over that log, with the account fold enabled on first visit.
import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import { AllowAccount } from "../../components/allow-account.tsx";
import { ContextActivity, type ActivityItx } from "../../components/context-activity.tsx";

export const Route = createFileRoute("/_auth/activity")({
  // the view's every choice — mode, filter, the inspected event, the open sheet — is this URL
  validateSearch: ContextViewState,
  staticData: { page: "Activity" },
  component: ActivityPage,
});

function ActivityPage() {
  const { api, info } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const canReadAccount = info.scopes.includes("account");
  const [user, setUser] = useState<ActivityItx>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!canReadAccount) return;
    let disposed = false;
    let held: Awaited<typeof api.user> | undefined;
    // A capnweb stub is a callable proxy: handed to a state setter directly, React would take it
    // for an updater and CALL it — so it is wrapped in a thunk.
    Promise.resolve(api.user).then(
      (stub) => {
        if (disposed) return stub[Symbol.dispose]();
        held = stub;
        setUser(() => stub);
      },
      (caught: unknown) =>
        !disposed && setError(caught instanceof Error ? caught.message : String(caught)),
    );
    return () => {
      disposed = true;
      held?.[Symbol.dispose]();
    };
  }, [api, canReadAccount]);
  if (!canReadAccount)
    return (
      <AllowAccount
        title="Activity"
        next="/activity"
        description="This session may not read your account's record."
        action="Allow the dash to read it"
      />
    );
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-muted-foreground">
          Your account's record: every sign-in, token and consent, as the platform wrote it — and
          what the account fold made of it.
        </p>
      </div>
      {error ? (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <ContextActivity
          state={search}
          onStateChange={(patch) =>
            void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })
          }
          itx={user}
          title={<span className="font-mono text-xs">/users/{info.principal.actor}</span>}
          ensureProcessor="account"
        />
      )}
    </div>
  );
}
