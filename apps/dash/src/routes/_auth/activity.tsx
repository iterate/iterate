// /activity — the person's own record: everything that happened on their account context
// (`session.user`, the global `/users/<id>`): sign-ins, tokens minted and ended, consents approved —
// the context view over that log, with the account fold enabled on first visit.
import { createFileRoute } from "@tanstack/react-router";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import { AllowAccount } from "../../components/allow-account.tsx";
import { ContextActivity } from "../../components/context-activity.tsx";
import { useContextStub } from "../../lib/context-stub.ts";

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
  const user = useContextStub(canReadAccount ? () => Promise.resolve(api.user) : null, [
    api,
    canReadAccount,
  ]);
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
      {user.error ? (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {user.error}
        </p>
      ) : (
        <ContextActivity
          state={search}
          onStateChange={(patch) =>
            void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })
          }
          itx={user.stub}
          title={<span className="font-mono text-xs">/users/{info.principal.actor}</span>}
          ensureProcessor="account"
        />
      )}
    </div>
  );
}
