// /organizations/<organization>/activity — the organization's record: created, renamed, the
// projects created in it — the context view over `session.organizations.get(orgId)`'s log, with
// the organization fold enabled on first visit. Reached from the organization's page. A sibling
// of the settings route, not its child (the `_` in the file name): the settings page renders no outlet.
import { useEffect, useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ContextActivity, type ActivityItx } from "../../../components/context-activity.tsx";

export const Route = createFileRoute("/_auth/organizations/$orgId_/activity")({
  beforeLoad: async ({ context, params }) => {
    const org = (await context.api.orgs()).find((candidate) => candidate.id === params.orgId);
    if (!org) throw notFound();
    return { org };
  },
  component: OrganizationActivity,
});

function OrganizationActivity() {
  const { api, org } = Route.useRouteContext();
  const [context, setContext] = useState<ActivityItx>();
  useEffect(() => {
    let disposed = false;
    api.organizations.get(org.id).then(
      (stub) => !disposed && setContext(() => stub as unknown as ActivityItx),
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [api, org.id]);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          <Link to="/organizations/$orgId" params={{ orgId: org.id }} className="hover:underline">
            {org.name}
          </Link>{" "}
          <span className="text-muted-foreground">· Activity</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          The organization's record: created, renamed, and every project created in it.
        </p>
      </div>
      <ContextActivity
        itx={context}
        title={<span className="font-mono text-xs">/organizations/{org.id}</span>}
        ensureProcessor="organization"
      />
    </div>
  );
}
