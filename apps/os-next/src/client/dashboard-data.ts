import { z } from "zod";
import type { AuthenticatedApp } from "./browser.ts";

const AppRows = z.array(z.object({ match: z.string(), target: z.unknown() }));

/** A dashboard's entire data path is the public session, including app discovery. */
export async function loadDashboard({ api, info }: AuthenticatedApp) {
  const [orgs, projects] = await Promise.all([api.orgs(), api.projects.list()]);
  const origin = new URL(info.platformOrigin);
  const rows = await Promise.all(
    projects.map(async (project) => {
      const open = info.projectHostnameBase
        ? `${origin.protocol}//${project.id}.${info.projectHostnameBase}${origin.port ? `:${origin.port}` : ""}/`
        : null;
      let apps: { label: string; open: string }[] = [];
      let appError: string | null = null;
      if (open) {
        try {
          using itx = await api.projects.get(project.id);
          const rules = AppRows.parse(await itx.invoke("itx.rewriteRules.list()"));
          apps = rules
            .filter((row) => row.target !== null && row.match.startsWith("itx.apps."))
            .map((row) => row.match.slice("itx.apps.".length))
            .filter((label) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(label))
            .map((label) => ({
              label,
              open: open.replace(`${project.id}.`, `${label}--${project.id}.`),
            }));
        } catch (error) {
          // A broken project remains listed and addressable from the fixed console.
          appError = error instanceof Error ? error.message : String(error);
        }
      }
      return { ...project, open, apps, appError };
    }),
  );
  return {
    email: info.principal.email || info.principal.actor,
    orgs,
    projects: rows,
    canManageAccount: info.scopes.includes("account"),
  };
}
