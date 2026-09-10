import type { ProjectIdOrSlug } from "./session.ts";

/** A DNS label: lowercase letters and digits, single hyphens inside. */
const DNS_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** An app label: a DNS label that is also an itx identifier (it becomes a step, `itx.apps.<label>`). */
const APP_LABEL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The labels `hostname` has under `base` — `site--p.iterate.app` ⇒ `["site--p"]` — lowercased, a
 *  trailing dot (a fully-qualified Host, `site--p.base.`) dropped; null when the hostname is not
 *  under `base` at all, and a blank `base` has nothing under it. */
export function hostnameLabelsUnderBase(hostname: string, base: string): string[] | null {
  if (!base) return null;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const suffix = `.${base.toLowerCase()}`;
  return host.endsWith(suffix) ? host.slice(0, -suffix.length).split(".") : null;
}

/** The app + project a host names, or null when `hostname` is not a project host under `base` (a
 *  blank `base` ⇒ no project-host ingress at all). `<app>--<project>.<base>` and
 *  `<app>.<project>.<base>` name the app `<app>`; the apex `<project>.<base>` names none (`app:
 *  null` — the config worker answers). `project` is the label as written, an id or a slug: whether
 *  the project EXISTS, and which id it is, is the directory's answer (the edge above). Pure. */
export function projectHostOf(
  hostname: string,
  base: string,
): { app: string | null; project: ProjectIdOrSlug } | null {
  const labels = hostnameLabelsUnderBase(hostname, base);
  if (labels === null || labels.length > 2) return null; // deeper than `<app>.<project>` is not a project host
  const [first, second] = labels as [string, string?];
  const separator = first.startsWith("xn--") ? -1 : first.indexOf("--"); // `xn--…` is an IDN label (punycode), never `<app>--<project>`
  const [app, project] =
    second !== undefined
      ? [first, second] // `<app>.<project>`
      : separator === -1
        ? [null, first] // the apex, `<project>`
        : [first.slice(0, separator), first.slice(separator + 2)]; // `<app>--<project>`
  if (!DNS_LABEL.test(project) || (app !== null && !APP_LABEL.test(app))) return null;
  return { app, project };
}
