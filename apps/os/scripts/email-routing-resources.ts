import { CloudflareApiError } from "../../../scripts/lib/env-context.ts";
import { emailDomainForDeployment } from "../src/domains/email/utils.ts";

type EmailRoutingContext = {
  cf: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  cfV4: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  env: { cloudflareAccountId: string };
  name: string;
};

export async function ensureInboundEmailRouting(
  ctx: EmailRoutingContext,
  input: {
    projectHostnameBases: string[];
    workerName: string;
    workerRequirement: "allow-missing-before-first-deploy" | "require-deployed-worker";
  },
): Promise<"configured" | "deferred-until-worker-deploy" | "deferred-until-zone"> {
  const emailBase = emailDomainForDeployment(input.projectHostnameBases);
  if (emailBase === null) {
    throw new Error(`${ctx.name} has no project hostname base for inbound email`);
  }

  const zones = await ctx.cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${ctx.env.cloudflareAccountId}&per_page=500`,
  );
  const zone = zones.find((candidate) => candidate.name === emailBase);
  if (!zone) {
    if (input.workerRequirement === "allow-missing-before-first-deploy") {
      console.warn(
        `no zone named ${emailBase} in account ${ctx.env.cloudflareAccountId}; Email Routing deferred until the zone exists`,
      );
      return "deferred-until-zone";
    }
    throw new Error(`no zone named ${emailBase} in account ${ctx.env.cloudflareAccountId}`);
  }

  const routing = await ctx.cfV4<{ enabled?: boolean }>(`/zones/${zone.id}/email/routing`);
  if (routing.enabled !== true) {
    await ctx.cfV4(`/zones/${zone.id}/email/routing/enable`, { method: "POST", body: "{}" });
    console.log(`enabled Email Routing on ${zone.name}`);
  } else {
    console.log(`Email Routing on ${zone.name} already enabled`);
  }

  const workerExists = await cloudflareWorkerExists(ctx, input.workerName);
  if (!workerExists) {
    if (input.workerRequirement === "require-deployed-worker") {
      throw new Error(
        `Inbound Email Routing for ${ctx.name} requires deployed worker ${input.workerName}`,
      );
    }
    console.log(
      `Email Routing catch-all on ${zone.name} deferred until worker ${input.workerName} deploys`,
    );
    return "deferred-until-worker-deploy";
  }

  await ctx.cfV4(`/zones/${zone.id}/email/routing/rules/catch_all`, {
    method: "PUT",
    body: JSON.stringify({
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [input.workerName] }],
      enabled: true,
      name: `${ctx.name} inbound project email (ensure-resources.ts)`,
    }),
  });
  console.log(`Email Routing catch-all on ${zone.name} -> worker ${input.workerName}`);
  return "configured";
}

async function cloudflareWorkerExists(
  ctx: Pick<EmailRoutingContext, "cf">,
  workerName: string,
): Promise<boolean> {
  const path = `/workers/scripts/${encodeURIComponent(workerName)}/settings`;
  try {
    await ctx.cf(path);
    return true;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return false;
    throw error;
  }
}
