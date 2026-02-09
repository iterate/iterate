import { getDbWithEnv, DB } from "../backend/db/client.ts";
import { isValidSlug } from "../backend/utils/slug.ts";
import type { proxyWorker } from "../alchemy.run.ts";
export type ProxyWorkerBindings = typeof proxyWorker.Env;

export { ProjectIngressProxy } from "./project-ingress-proxy.ts";

export default {
  async fetch(request: Request, env: ProxyWorkerBindings) {
    console.log(request);
    // This Works, now to hook up the proxy to the Daytona proxy
    return fetch(
      "https://3000-9a37f0dd-1391-4240-bc47-8ee4b172479e.proxy.daytona.works/api/pty/ws",
      request,
    );
  },
};

async function getMachineIdAndPort(
  db: DB,
  subdomain: string,
): Promise<{ machineId: string; port: number } | null> {
  if (subdomain.includes("__")) {
    // Direct usage of machine ID or project ID — port is required
    const [id, portString] = subdomain.split("__");
    if (!id || !portString) return null;

    const machineId = id.startsWith("mach_") ? id : await getMachineIdFromProjectId(db, id);
    if (!machineId) return null;

    const port = portString === "default" ? 3000 : Number(portString);
    if (Number.isNaN(port)) return null;

    return { machineId, port };
  }

  // Slug-based access with optional port
  const [slug, portString] = subdomain.split("_");
  if (!slug || !isValidSlug(slug)) return null;

  const machineId = await getMachineIdFromProjectSlug(db, slug);
  if (!machineId) return null;

  const port = portString ? Number(portString) : 3000;
  if (Number.isNaN(port)) return null;

  return { machineId, port };
}

async function getMachineIdFromProjectSlug(db: DB, slug: string): Promise<string | null> {
  const project = await db.query.project.findFirst({
    where: (t, { eq }) => eq(t.slug, slug),
    with: {
      machines: {
        where: (t, { eq }) => eq(t.state, "active"),
        limit: 1,
        columns: { id: true },
      },
    },
  });

  return project?.machines[0]?.id ?? null;
}

async function getMachineIdFromProjectId(db: DB, projectId: string): Promise<string | null> {
  const machine = await db.query.machine.findFirst({
    where: (t, { and, eq }) => and(eq(t.projectId, projectId), eq(t.state, "active")),
    columns: { id: true },
  });

  return machine?.id ?? null;
}
