import { createHash } from "node:crypto";
import { z } from "zod";
import type { DeployableEnv, EnvContext } from "./env-context.ts";

type CfContext = Pick<EnvContext<DeployableEnv>, "cf">;

const WorkerScript = z.object({
  id: z.string(),
  migration_tag: z.string().nullable().optional(),
});
const DurableObjectNamespace = z.object({
  class: z.string(),
  id: z.string(),
  script: z.string().nullable(),
});

async function getWorkerDoClassNames(ctx: CfContext, workerName: string): Promise<string[]> {
  const classNames: string[] = [];
  for (let page = 1; ; page += 1) {
    const batch = z
      .array(DurableObjectNamespace)
      .parse(await ctx.cf(`/workers/durable_objects/namespaces?per_page=100&page=${page}`));
    for (const namespace of batch) {
      if (namespace.script === workerName) classNames.push(namespace.class);
    }
    if (batch.length < 100) return classNames;
  }
}

/**
 * Container-enable missing Durable Object classes before Wrangler's exports
 * reconciliation creates them.
 *
 * Cloudflare still cannot container-enable a namespace created through
 * `exports`. A legacy migration whose upload metadata names the container
 * classes must create them first; the real Wrangler deploy immediately
 * replaces this bootstrap module and adopts those classes through `exports`.
 * Delete this function once the control plane supports container-enabled
 * exports directly.
 */
export async function ensureContainerClasses(input: {
  ctx: CfContext;
  workerName: string;
  containerClassNames: string[];
  compatibilityDate: string;
}): Promise<{ action: "skipped" | "bootstrapped"; missing: string[] }> {
  if (input.containerClassNames.length === 0) return { action: "skipped", missing: [] };

  const scripts = z.array(WorkerScript).parse(await input.ctx.cf("/workers/scripts"));
  const script = scripts.find((candidate) => candidate.id === input.workerName);
  const liveClassNames = script ? await getWorkerDoClassNames(input.ctx, input.workerName) : [];
  const liveNames = new Set(liveClassNames);
  const missing = input.containerClassNames.filter((name) => !liveNames.has(name)).sort();
  if (missing.length === 0) return { action: "skipped", missing: [] };

  console.log(`container-class bootstrap: creating ${missing.join(", ")} on ${input.workerName}`);
  const stubExports = [...missing, ...liveClassNames]
    .sort()
    .map((className) => `export class ${className} { constructor() {} }`)
    .join("\n");
  const form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({
      main_module: "bootstrap.mjs",
      compatibility_date: input.compatibilityDate,
      bindings: [],
      containers: missing.map((className) => ({ class_name: className })),
      migrations: {
        ...(script?.migration_tag ? { old_tag: script.migration_tag } : {}),
        new_tag: `container-bootstrap-${createHash("sha256")
          .update(JSON.stringify([script?.migration_tag ?? null, missing]))
          .digest("hex")
          .slice(0, 8)}`,
        steps: [{ new_sqlite_classes: missing }],
      },
    }),
  );
  form.append(
    "bootstrap.mjs",
    new File(
      [
        "export default { fetch() { return new Response('environment is being provisioned', { status: 503 }); } }\n",
        stubExports,
      ],
      "bootstrap.mjs",
      { type: "application/javascript+module" },
    ),
    "bootstrap.mjs",
  );

  try {
    await input.ctx.cf(`/workers/scripts/${encodeURIComponent(input.workerName)}`, {
      method: "PUT",
      body: form,
    });
  } catch (error) {
    if (String(error).includes("100403")) {
      throw new Error(
        `${input.workerName} is exports-locked without container-enabled classes ` +
          `${missing.join(", ")}. Destroy and recreate its environment before deploying.`,
      );
    }
    throw error;
  }
  return { action: "bootstrapped", missing };
}
