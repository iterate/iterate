// Backfill a project's missing OS-side bootstrap before entering it.
//
// Projects created via the sign-in browser's org/project-setup screen
// (apps/auth's project-access flow) only ever get an auth-directory row —
// apps/auth cannot call into apps/os, so no OS project stream gets
// appended, meaning no capability host, no scheduler, nothing.
// deploymentStatus: "missing" is exactly that state. Mirrors the OS web
// dashboard's own backfill (apps/os/src/lib/project-server-fns.ts's
// getRootProjectRedirectServerFn): call projects.get(slug).create() with the
// EXISTING id/slug to finish the bootstrap, rather than failing later
// inside whatever screen first touches the project's capability host.

import type { ProjectListEntry } from "../../../os/src/itx-api.generated.ts";
import type { ItxSession } from "./itx-core.ts";
import type { LastProject } from "./storage.ts";

export function rememberedProjectInScope(
  remembered: LastProject,
  projects: ProjectListEntry[],
): LastProject | null {
  const current = projects.find((project) => project.id === remembered.id);
  return current ? { id: current.id, slug: current.slug } : null;
}

export async function backfillProjectIfMissing(
  itx: ItxSession,
  project: ProjectListEntry,
): Promise<void> {
  if (project.deploymentStatus !== "missing") return;
  await itx.projects.get(project.slug).create({
    projectId: project.id,
    ...(project.organizationSlug ? { organizationSlug: project.organizationSlug } : {}),
  });
}
