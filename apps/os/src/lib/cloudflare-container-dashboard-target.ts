import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { itxAuthFromPrincipal } from "~/auth.ts";
import { DurableObjectNameCodec } from "~/domains/durable-object-names.ts";
import {
  SANDBOX_INSTANCE_TYPE_BINDINGS,
  SandboxInstanceType,
} from "~/domains/sandboxes/instance-types.ts";
import { assertSandboxPath } from "~/domains/sandboxes/utils.ts";
import { itxEnv, type Env } from "~/env.ts";
import {
  cloudflareContainerApplicationName,
  type CloudflareContainerDashboardTarget,
} from "~/lib/cloudflare-containers-dashboard-url.ts";

const CloudflareContainerDashboardTargetInput = z.object({
  instanceType: SandboxInstanceType,
  projectId: z.string().trim().min(1),
  sandboxPath: z.string().transform(assertSandboxPath),
});

/** Resolve the two opaque IDs Cloudflare's dashboard route requires. The
 * instance ID is deterministic from the sandbox namespace; only the
 * application UUID needs a control-plane lookup. */
export const getCloudflareContainerDashboardTarget: (input: {
  data: z.input<typeof CloudflareContainerDashboardTargetInput>;
}) => Promise<CloudflareContainerDashboardTarget | null> = createServerFn({ method: "GET" })
  .validator((input: z.input<typeof CloudflareContainerDashboardTargetInput>) =>
    CloudflareContainerDashboardTargetInput.parse(input),
  )
  .handler(async ({ context, data }) => {
    const principal = context.principal;
    if (!principal) throw new Error("Authentication is required to inspect a sandbox container.");

    const auth = itxAuthFromPrincipal(principal, {
      allowDirectoryFallback: context.operatorSession == null,
    });
    await auth.ensureCanAccessProject?.(data.projectId);
    auth.assertCanAccessProject(data.projectId);

    const workerName = context.config.cloudflare.workerName ?? itxEnv.WORKER_SELF;
    const { binding, className } = SANDBOX_INSTANCE_TYPE_BINDINGS[data.instanceType];
    const applicationName = cloudflareContainerApplicationName({ className, workerName });
    const accountId = context.config.cloudflare.accountId;
    const apiToken = context.config.cloudflare.apiToken?.exposeSecret();
    // A fully local dev environment has no Cloudflare container application.
    if (!accountId || !apiToken || !applicationName || workerName === "os") return null;

    const applicationId = await cloudflareContainerApplicationId({
      accountId,
      apiToken,
      applicationName,
    });
    const namespace = itxEnv[binding as keyof Env] as unknown as DurableObjectNamespace;
    const durableObjectName = DurableObjectNameCodec.stringify({
      path: data.sandboxPath,
      projectId: data.projectId,
    });
    const instanceId = namespace.idFromName(durableObjectName).toString();
    if (!/^[a-f0-9]{64}$/i.test(instanceId)) {
      throw new Error(
        `Cloudflare returned an invalid container instance id for "${data.sandboxPath}".`,
      );
    }

    return { applicationId, instanceId };
  });

type CloudflareApiEnvelope = {
  errors?: Array<{ code?: number; message?: string }>;
  result?: unknown;
  success?: boolean;
};

async function cloudflareContainerApplicationId(input: {
  accountId: string;
  apiToken: string;
  applicationName: string;
}): Promise<string> {
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/containers/applications`,
  );
  url.searchParams.set("name", input.applicationName);
  url.searchParams.set("per_page", "5");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${input.apiToken}` },
  });
  const body = (await response.json().catch(() => ({}))) as CloudflareApiEnvelope;
  if (!response.ok || body.success === false) {
    const details = body.errors
      ?.map((error) => [error.code, error.message].filter(Boolean).join(": "))
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Cloudflare container application lookup failed (${response.status})${details ? `: ${details}` : ""}.`,
    );
  }
  if (!Array.isArray(body.result)) {
    throw new Error("Cloudflare container application lookup returned no result array.");
  }

  const matches = (body.result as Array<{ id?: unknown; name?: unknown }>).filter(
    (application) => application.name === input.applicationName,
  );
  if (matches.length === 0) {
    throw new Error(`Cloudflare container application "${input.applicationName}" was not found.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Cloudflare returned multiple container applications named "${input.applicationName}".`,
    );
  }
  const applicationId = matches[0]?.id;
  if (
    typeof applicationId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(applicationId)
  ) {
    throw new Error(
      `Cloudflare returned an invalid id for container application "${input.applicationName}".`,
    );
  }
  return applicationId;
}
