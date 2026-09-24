// /organizations/<organization>/activity — the organization's record: created, renamed, the
// projects created in it — the context view over `session.organizations.get(orgId)`'s log, with
// the organization fold enabled on first visit. Reached from the organization's page; the name is
// the tree's (components/organization-tree.tsx), and an organization the tree does not hold is not
// found. A sibling of the settings route, not its child (the `_` in the file name): the settings
// page renders no outlet.
import { useEffect, useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import { ContextActivity, type ActivityItx } from "../../../components/context-activity.tsx";
import { useOrganizationTreeEntry } from "../../../components/organization-tree.tsx";

export const Route = createFileRoute("/_auth/organizations/$orgId_/activity")({
  // the view's every choice — mode, filter, the inspected event, the open sheet — is this URL
  validateSearch: ContextViewState,
  component: OrganizationActivity,
});

function OrganizationActivity() {
  const { api } = Route.useRouteContext();
  const { orgId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { org, missing } = useOrganizationTreeEntry(orgId);
  const [context, setContext] = useState<ActivityItx>();
  useEffect(() => {
    let disposed = false;
    let held: Awaited<ReturnType<typeof api.organizations.get>> | undefined;
    api.organizations.get(orgId).then(
      (stub) => {
        if (disposed) return stub[Symbol.dispose]();
        held = stub;
        setContext(() => stub);
      },
      () => undefined,
    );
    return () => {
      // another organization, or gone: release the stub and show nothing until the next one lands
      disposed = true;
      held?.[Symbol.dispose]();
      setContext(undefined);
    };
  }, [api, orgId]);
  if (missing) throw notFound();
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          <Link to="/organizations/$orgId" params={{ orgId }} className="hover:underline">
            {org?.name || orgId}
          </Link>{" "}
          <span className="text-muted-foreground">· Activity</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          The organization's record: created, renamed, and every project created in it.
        </p>
      </div>
      <ContextActivity
        state={search}
        onStateChange={(patch) =>
          void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true })
        }
        itx={context}
        title={<span className="font-mono text-xs">/organizations/{orgId}</span>}
        ensureProcessor="organization"
      />
    </div>
  );
}
