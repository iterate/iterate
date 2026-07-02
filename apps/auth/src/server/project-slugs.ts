import { ORPCError } from "@orpc/server";
import { slugify } from "@iterate-com/shared/slug";
import type { Client } from "sqlfu";
import { getProjectById, getProjectBySlug } from "./db/queries/index.ts";

// Auth is the durable source for user-owned projects, while OS keeps its own
// per-environment project row. In preview/dev we often delete the OS worker's
// D1 database without deleting auth's database. OS then reads the auth session,
// shows the user "orphaned" auth projects, and lets them quickly recreate the
// missing OS rows.
//
// This resolver is the auth-side half of that adoption flow:
// - same organization + same slug, optionally with the same id, means "use the
//   project auth already knows about";
// - same slug in another organization is a real conflict;
// - we never append random suffixes, because OS must recreate the exact auth
//   project slug so routes and project hostnames stay stable across DB resets.
export type ProjectCreateTarget =
  | { kind: "existing"; project: getProjectBySlug.Result }
  | { kind: "new"; slug: string };

export async function resolveProjectCreateTarget(input: {
  db: Client;
  id?: string;
  name: string;
  organizationId: string;
  slug?: string;
}): Promise<ProjectCreateTarget> {
  const slug = slugify(input.slug ?? input.name);

  const existingById = input.id ? await getProjectById(input.db, { id: input.id }) : null;
  if (existingById) {
    // A caller-provided id is an adoption request only if it names the same
    // slug in the same organization. Any drift means the caller is trying to
    // bind one identity to a different project, so fail instead of guessing.
    if (existingById.slug !== slug) {
      throw new ORPCError("CONFLICT", {
        message: `Project ${input.id} already exists with slug ${existingById.slug}.`,
      });
    }
    if (existingById.organizationId !== input.organizationId) {
      throw new ORPCError("CONFLICT", {
        message: `Project slug ${slug} is already taken.`,
      });
    }
    return { kind: "existing", project: existingById };
  }

  const existingBySlug = await getProjectBySlug(input.db, { slug });
  if (!existingBySlug) return { kind: "new", slug };

  // Slugs are globally unique in auth today. Returning an existing same-org
  // row supports OS re-adoption; returning an other-org row would leak or steal
  // a project identity, so treat it as taken.
  if (existingBySlug.organizationId !== input.organizationId) {
    throw new ORPCError("CONFLICT", {
      message: `Project slug ${slug} is already taken.`,
    });
  }

  if (input.id && existingBySlug.id !== input.id) {
    throw new ORPCError("CONFLICT", {
      message: `Project slug ${slug} already exists with id ${existingBySlug.id}.`,
    });
  }

  return { kind: "existing", project: existingBySlug };
}
