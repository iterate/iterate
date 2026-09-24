// How the dash reads a fact: one sentence per event type the control plane and the platform record
// on a person's, an organization's or a project's context — the context view's renderer registry.
// The platform's own events (the stream's lifecycle, script runs) come with the view's renderers;
// anything not named there or here falls back to the view's default row (the type and a glance).
import { list, mono, record, str } from "@iterate-com/ui/components/context-view/renderer-helpers";
import type { EventRenderers } from "@iterate-com/ui/components/context-view/types";

const platformFactRenderers: EventRenderers = {
  "events.iterate.com/account/authenticated": (e) => {
    const p = record(e.payload);
    return (
      <>
        Signed in{" "}
        {p.credential === "admin-secret" ? "with the admin secret" : "with a browser cookie"}
      </>
    );
  },
  "events.iterate.com/account/personal-access-token-minted": (e) => {
    const p = record(e.payload);
    const projects = list(p.projects);
    return (
      <>
        Minted the personal access token <strong>{str(p.name, "unnamed")}</strong> for{" "}
        {projects.length} {projects.length === 1 ? "project" : "projects"} {mono(str(p.id))}
      </>
    );
  },
  "events.iterate.com/account/grant-ended": (e) => (
    <>Ended the grant {mono(str(record(e.payload).grantId))}</>
  ),
  "events.iterate.com/account/grant-used": (e) => (
    <>Used the grant {mono(str(record(e.payload).grantId))}</>
  ),
  "events.iterate.com/account/consent-approved": (e) => {
    const p = record(e.payload);
    const projects =
      p.projects === null ? "every project" : `${list(p.projects).length} project(s)`;
    return (
      <>
        Approved <strong>{str(p.clientName, str(p.clientId))}</strong> for {projects} ·{" "}
        {list(p.scopes).join(", ")}
      </>
    );
  },
  "events.iterate.com/organization/created": (e) => (
    <>
      Created the organization <strong>{str(record(e.payload).name)}</strong>
    </>
  ),
  "events.iterate.com/organization/renamed": (e) => (
    <>
      Renamed the organization to <strong>{str(record(e.payload).name)}</strong>
    </>
  ),
  "events.iterate.com/organization/deleted": () => <>Deleted the organization</>,
  "events.iterate.com/organization/member-added": (e) => {
    const p = record(e.payload);
    return (
      <>
        Added {mono(str(p.userId))} as <strong>{str(p.role)}</strong> of {mono(str(p.orgId))}
      </>
    );
  },
  "events.iterate.com/organization/member-removed": (e) => {
    const p = record(e.payload);
    return (
      <>
        Removed {mono(str(p.userId))} from {mono(str(p.orgId))}
      </>
    );
  },
  "events.iterate.com/organization/project-created": (e) => {
    const p = record(e.payload);
    return (
      <>
        Created the project <strong>{str(p.slug)}</strong> {mono(str(p.projectId))}
      </>
    );
  },
};

/** Only a fact the platform wrote (`source.platform`) reads as a sentence: one a person appended to
 *  their own context under the same type shows as the raw event it is. */
export const factRenderers: EventRenderers = Object.fromEntries(
  Object.entries(platformFactRenderers).map(([type, render]) => [
    type,
    (event) => (event.source?.platform ? render(event) : null),
  ]),
);
