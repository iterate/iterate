import type { StartAppConfig } from "@iterate-com/shared/start-app-config";

/** The first-party apps the dash points at — each its own worker on its own origin, an ordinary
 *  OAuth client of the platform like the dash itself, serving a project at `/projects/<slug>`.
 *  Their origins are this deployment's (`appDirectory`). Nothing here is required for the dash to
 *  work; it is a directory. Kit is not in it: it installs a device, it does not open a project. */
const APPS = [
  {
    id: "agents",
    name: "Agents",
    blurb:
      "Talk to a project's agents: the feed, the scripts they run, the trace of every request.",
  },
  {
    id: "notes",
    name: "Notes",
    blurb: "A page of notes per project, kept in the project's workspace.",
  },
  {
    id: "voice",
    name: "Voice",
    blurb: "A phone in the browser: press, talk to a project's voice agent.",
  },
] as const;

/** The directory as this deployment has it: each app at the origin the worker's `APP_CONFIG
 *  urls` names (scripts/lib/start-app.ts: prd's from envs.ts; a per-PR preview's, the same PR's
 *  app previews). An app it names no origin for — a preview run that did not deploy it — is not
 *  listed: its production origin would not know the preview's projects. */
export function appDirectory(urls: StartAppConfig["urls"]) {
  return APPS.flatMap((app) => {
    const url = urls[app.id];
    return url ? [{ ...app, url }] : [];
  });
}
