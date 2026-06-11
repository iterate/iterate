/**
 * Cap-host ingress rule synthesis (`{cap}--{project}.{base}` hostnames), in
 * its own module so the ingress router worker can resolve cap hosts without
 * bundling the itx runtime — http.ts drags capnweb in via the journal.
 * The synthesized callable targets the ItxCapabilityIngress entrypoint,
 * which lives in the project worker (workers/project.ts).
 */
import type { FetchCallable } from "@iterate-com/shared/callable/types.ts";
import { normalizeIngressHost } from "~/ingress/host-headers.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";

/** Hostname → routing rule for cap hosts; null when the host isn't one. */
export async function getItxCapabilityHostIngressRule(input: {
  bases: readonly string[];
  db: D1Database;
  host: string;
}): Promise<ExactHostIngressRule | null> {
  const host = normalizeIngressHost(input.host);

  for (const rawBase of input.bases) {
    const base = normalizeIngressHost(normalizeProjectHostnameBase(rawBase));
    if (host === base || !host.endsWith(`.${base}`)) continue;

    const prefix = host.slice(0, host.length - base.length - 1);
    if (prefix.includes(".")) continue;

    // Only the project-level form `{cap}--{project}` is implemented. The spec
    // also reserves `{cap}--{ctxId}--{project}` for child-context caps; that
    // routing isn't built yet, so we require EXACTLY two `--`-separated parts
    // and let any other shape fall through (fails closed → 404) rather than
    // mis-parsing `ctxId--project` as a project identifier.
    const parts = prefix.split("--");
    if (parts.length !== 2) continue;
    const [capability, projectIdentifier] = parts;
    if (!capability || !projectIdentifier) continue;

    const project = await input.db
      .prepare(`SELECT id FROM projects WHERE slug = ? OR id = ? LIMIT 1`)
      .bind(projectIdentifier, projectIdentifier)
      .first<{ id: string }>();
    if (!project) return null;

    const callable = {
      type: "fetch",
      via: {
        type: "loopback-binding",
        bindingType: "service",
        exportName: "ItxCapabilityIngress",
        props: { capability, projectId: project.id },
      },
    } satisfies FetchCallable;

    return {
      id: `itx-capability-host:${project.id}:${capability}`,
      host,
      projectId: project.id,
      priority: 60,
      notes: "itx capability hostname",
      callable,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  }

  return null;
}
