import { z } from "zod/v4";
import { getDbWithEnv } from "../backend/db/client.ts";
import { isValidSlug, validateTypeId } from "../backend/utils/slug.ts";
import type { proxyWorker } from "../alchemy.run.ts";
export type ProxyWorkerBindings = typeof proxyWorker.Env;

export { ProjectIngressProxy } from "./project-ingress-proxy.ts";

const parseSubdomain = (
  subdomain: string,
): ({ port?: number } & ({ projectSlug: string } | { projectId: string })) | null => {
  const parts = subdomain.split("_");

  const validateProject = (slug: string) => {
    if (isValidSlug(slug)) return { projectSlug: slug };
    if (validateTypeId(slug, "prj")) return { projectId: slug };
    return null;
  };

  if (parts.length === 1) return validateProject(parts[0]);

  if (parts.length === 2) {
    const portRes = z.coerce.number().int().positive().max(65535).safeParse(parts[1]);
    if (!portRes.success) return null;
    const port = portRes.data;
    const project = validateProject(parts[0]);
    if (!project) return null;
    return { ...project, port };
  }

  return null;
};

export default {
  async fetch(request: Request, env: ProxyWorkerBindings) {
    const domain = new URL(request.url).hostname;
    const db = getDbWithEnv(env);

    const doName = `proxy-${domain}`; // TODO: stable name
    const stub = env.PROJECT_INGRESS_PROXY.getByName(doName);
    return stub.fetch(request);
  },
};
