import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { itxAuthFromPrincipal } from "~/auth.ts";
import { itxEnv as env } from "~/env.ts";

const Input = z.object({ projectId: z.string() });

/**
 * The custom hostnames ingress routes to one project — a reverse scan of the
 * hostname directory (`hostname:<host>` keys, written by custom-domain
 * provisioning). The directory is the routing truth: the processor's
 * `customDomains` state can lag it or predate it (prd's `iterate.com` is a
 * direct registration with no domain events behind it). The directory stays
 * small deployment-wide, so a prefix scan per call is fine, and callers cache.
 *
 * Sorted apex-most first — fewest labels, then shortest — so `garple.com`
 * beats `www.garple.com` as a project's canonical address.
 */
export const getProjectCustomHostnames = createServerFn({ method: "GET" })
  .validator((input: z.input<typeof Input>) => Input.parse(input))
  .handler(async ({ context, data }): Promise<string[]> => {
    const principal = context.principal;
    if (!principal) return [];
    const auth = itxAuthFromPrincipal(principal, {
      allowDirectoryFallback: !context.operatorSession,
    });
    await auth.ensureCanAccessProject?.(data.projectId);
    auth.assertCanAccessProject(data.projectId);
    const hostnames: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.PROJECT_DIRECTORY.list({ cursor, prefix: "hostname:" });
      const records = await Promise.all(
        page.keys.map((key) =>
          env.PROJECT_DIRECTORY.get<{ id?: string }>(key.name, "json")
            .then((record) => ({ key: key.name, record }))
            .catch(() => null),
        ),
      );
      for (const entry of records) {
        if (entry?.record?.id === data.projectId) {
          hostnames.push(entry.key.slice("hostname:".length));
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return hostnames.sort(
      (a, b) =>
        a.split(".").length - b.split(".").length || a.length - b.length || a.localeCompare(b),
    );
  });
