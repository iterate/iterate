import { createServerFn } from "@tanstack/react-start";
// oxlint-disable-next-line iterate/no-capnweb-http-batch -- server functions are one-shot request-scoped calls: a single pipelined batch (authenticate -> append/snapshot) with no socket lifecycle to manage.
import { newHttpBatchRpcSession } from "capnweb";
import { normalizeProjectCustomDomain } from "~/domains/projects/custom-domains.ts";
import { ProjectProcessorContract } from "~/domains/projects/project-processor-contract.ts";
import type { RequestContext } from "~/request-context.ts";
import type { UnauthenticatedOs } from "~/types.ts";

type CustomDomainMutationResult = {
  hostname: string;
  offset: number;
};

export const addProjectCustomDomainServerFn: (input: {
  data: { hostname: string; projectId: string };
}) => Promise<CustomDomainMutationResult> = createServerFn({ method: "POST" })
  .validator((input: { hostname: string; projectId: string }) => input)
  .handler(async ({ context, data }) => {
    const hostname = normalizeProjectCustomDomain({
      hostname: data.hostname,
      projectHostnameBases: context.config.projectHostnameBases ?? [],
    });
    const [event] = await appendProjectCustomDomainEvent(context, data.projectId, {
      type: "events.iterate.com/project/custom-domain-add-requested",
      payload: { hostname },
    });
    return { hostname, offset: event!.offset };
  });

export const refreshProjectCustomDomainServerFn: (input: {
  data: { hostname: string; projectId: string };
}) => Promise<CustomDomainMutationResult> = createServerFn({ method: "POST" })
  .validator((input: { hostname: string; projectId: string }) => input)
  .handler(async ({ context, data }) => {
    const hostname = normalizeProjectCustomDomain({
      hostname: data.hostname,
      projectHostnameBases: context.config.projectHostnameBases ?? [],
    });
    const [event] = await appendProjectCustomDomainEvent(context, data.projectId, {
      type: "events.iterate.com/project/custom-domain-refresh-requested",
      payload: { hostname },
    });
    return { hostname, offset: event!.offset };
  });

export const removeProjectCustomDomainServerFn: (input: {
  data: { hostname: string; projectId: string };
}) => Promise<CustomDomainMutationResult> = createServerFn({ method: "POST" })
  .validator((input: { hostname: string; projectId: string }) => input)
  .handler(async ({ context, data }) => {
    const hostname = normalizeProjectCustomDomain({
      hostname: data.hostname,
      projectHostnameBases: context.config.projectHostnameBases ?? [],
    });
    await assertProjectCustomDomainConfigured(context, data.projectId, hostname);
    const [event] = await appendProjectCustomDomainEvent(context, data.projectId, {
      type: "events.iterate.com/project/custom-domain-remove-requested",
      payload: { hostname },
    });
    return { hostname, offset: event!.offset };
  });

function engineBatchSession(context: RequestContext) {
  const baseUrl = (context.config.baseUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("baseUrl is not configured");
  const cookie = context.rawRequest?.headers.get("cookie");
  if (!cookie) throw new Error("Sign in to reach the project engine.");
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- one-shot pipelined batch per request; no socket lifecycle to manage in a server function.
  return newHttpBatchRpcSession<UnauthenticatedOs>(
    new Request(`${baseUrl}/api`, {
      method: "POST",
      headers: { cookie },
    }),
  );
}

async function appendProjectCustomDomainEvent(
  context: RequestContext,
  projectId: string,
  event: Parameters<typeof ProjectProcessorContract.buildEvent>[0],
) {
  const session = engineBatchSession(context);
  const root = session.authenticate({ type: "from-server-cookie" });
  const project = await root.projects.get(projectId);
  return await project.streams.get("/").append(ProjectProcessorContract.buildEvent(event));
}

async function assertProjectCustomDomainConfigured(
  context: RequestContext,
  projectId: string,
  hostname: string,
): Promise<void> {
  const session = engineBatchSession(context);
  const root = session.authenticate({ type: "from-server-cookie" });
  const project = await root.projects.get(projectId);
  const { state } = await project.processor.snapshot();
  if (state.customDomains.some((domain) => domain.hostname === hostname)) return;
  throw new Error(`Custom domain "${hostname}" is not configured on this project.`);
}
