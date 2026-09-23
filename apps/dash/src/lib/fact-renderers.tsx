// How the dash reads a fact: one sentence per event type the control plane and the platform record
// on a person's, an organization's or a project's context — the context view's renderer registry.
// The platform's own events (the stream's lifecycle, script runs) come with the view's renderers;
// anything not named there or here falls back to the view's default row (the type and a glance).
import type { EventRenderers } from "@iterate-com/ui/components/context-view/types";

const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
/** A plain object (the payload's shape), else an empty one. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === "[object Object]";
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** A muted mono span for an id or a path inside a sentence. */
const mono = (text: string) => (
  <span className="font-mono text-xs text-muted-foreground">{text}</span>
);

export const factRenderers: EventRenderers = {
  "events.iterate.com/account/authenticated": (e) => {
    const p = record(e.payload);
    return (
      <>
        Signed in{" "}
        {p.credential === "admin-secret" ? "with the admin secret" : "with a browser cookie"}
      </>
    );
  },
  "events.iterate.com/account/grant-minted": (e) => {
    const p = record(e.payload);
    const projects = list(p.projects);
    return (
      <>
        Minted the personal access token <strong>{str(p.name, "unnamed")}</strong> for{" "}
        {projects.length} {projects.length === 1 ? "project" : "projects"} {mono(str(p.grantId))}
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
