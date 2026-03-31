import { z } from "zod";

export const WorkerEnvVars = z.object({
  // alchemy.run.ts parses this from the app env contract and uses it to attach
  // Cloudflare routes, but it is not exposed as a runtime Worker binding.
  //
  // Keep every hostname shape we expect to serve here explicitly. Cloudflare
  // route matching and edge certificates are both host-pattern sensitive. For
  // example, `*.e2e-test.ingress.iterate.com/*` does NOT cover a deeper dotted
  // host like `events.example.e2e-test.ingress.iterate.com`; that needs its
  // own nested wildcard route pattern, and HTTPS may also need a matching edge
  // certificate for that deeper wildcard.
  WORKER_ROUTES: z
    .string()
    .trim()
    .min(1, "WORKER_ROUTES is required")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().min(1)).min(1, "WORKER_ROUTES must contain at least one route")),
  // These are the actual runtime Worker bindings configured in alchemy.run.ts.
  INGRESS_PROXY_API_TOKEN: z.string().trim().min(1, "INGRESS_PROXY_API_TOKEN is required"),
  TYPEID_PREFIX: z.string().trim().min(1, "TYPEID_PREFIX is required"),
});
