import type { EmittedInput } from "../streams/processor-contracts.ts";
import type { StreamProcessor } from "../streams/stream-processor.ts";
import type { ProjectDirectoryRecord } from "../../project-directory.ts";
import type { StreamEvent } from "../../types.ts";
import type { ProjectCustomDomainDeps } from "./custom-domains.ts";
import {
  ProjectProcessorContract,
  type ProjectCustomDomainCloudflareSnapshot,
} from "./project-processor-contract.ts";

type ProjectReduceArgs = Parameters<StreamProcessor<typeof ProjectProcessorContract>["reduce"]>[0];
type ProjectProcessEventArgs = Parameters<
  StreamProcessor<typeof ProjectProcessorContract>["processEvent"]
>[0];

export function reduceCustomDomainEvent({
  event,
  state,
}: ProjectReduceArgs): ProjectReduceArgs["state"] | null {
  switch (event.type) {
    case "events.iterate.com/project/custom-domain-add-requested": {
      const existingDomain = state.customDomains.find(
        (domain) => domain.hostname === event.payload.hostname,
      );
      if (existingDomain) {
        return upsertCustomDomain(state, {
          ...existingDomain,
          error: null,
          status: existingDomain.status === "active" ? "active" : "requested",
          updatedAt: event.createdAt,
        });
      }
      return upsertCustomDomain(state, {
        certificateDelegationCname: null,
        cloudflareHostnameId: null,
        createdAt: event.createdAt,
        error: null,
        hostname: event.payload.hostname,
        hostnameStatus: null,
        ownershipVerification: null,
        sslStatus: null,
        status: "requested",
        updatedAt: event.createdAt,
        validationRecords: [],
        wildcard: true,
      });
    }
    case "events.iterate.com/project/custom-domain-cloudflare-observed":
      return upsertCustomDomain(state, {
        ...event.payload,
        createdAt:
          state.customDomains.find((domain) => domain.hostname === event.payload.hostname)
            ?.createdAt ?? event.createdAt,
        updatedAt: event.createdAt,
      });
    case "events.iterate.com/project/custom-domain-provision-failed": {
      const failedDomain = state.customDomains.find(
        (domain) => domain.hostname === event.payload.hostname,
      );
      if (!failedDomain) return state;
      return upsertCustomDomain(state, {
        ...failedDomain,
        error: event.payload.error,
        status: failedDomain.status === "active" ? "active" : "failed",
        updatedAt: event.createdAt,
      });
    }
    case "events.iterate.com/project/custom-domain-remove-requested":
      return markCustomDomainRemoving(state, event.payload.hostname, event.createdAt);
    case "events.iterate.com/project/custom-domain-removed":
      return {
        ...state,
        customDomains: state.customDomains.filter(
          (domain) => domain.hostname !== event.payload.hostname,
        ),
      };
    default:
      return null;
  }
}

export function processCustomDomainEvent({
  append,
  blockProcessorWhile,
  customDomains,
  event,
  projectId,
  state,
}: {
  append: ProjectProcessEventArgs["append"];
  blockProcessorWhile: ProjectProcessEventArgs["blockProcessorWhile"];
  customDomains?: ProjectCustomDomainDeps;
  event: ProjectProcessEventArgs["event"];
  projectId: string;
  state: ProjectProcessEventArgs["state"];
}): boolean {
  switch (event.type) {
    case "events.iterate.com/project/custom-domain-add-requested": {
      blockProcessorWhile(async () => {
        await appendCustomDomainObservation({
          append,
          eventOffset: event.offset,
          hostname: event.payload.hostname,
          operation: async () => {
            const provisioner = assertCustomDomainProvisioner(customDomains);
            const project =
              (await provisioner.readProject()) ?? projectRecordFromState(state, projectId);
            return await provisioner.ensure({ hostname: event.payload.hostname, project });
          },
          projectId,
        });
      });
      return true;
    }
    case "events.iterate.com/project/custom-domain-refresh-requested": {
      blockProcessorWhile(async () => {
        await appendCustomDomainObservation({
          append,
          eventOffset: event.offset,
          hostname: event.payload.hostname,
          operation: async () => {
            const provisioner = assertCustomDomainProvisioner(customDomains);
            const project =
              (await provisioner.readProject()) ?? projectRecordFromState(state, projectId);
            return await provisioner.refresh({
              hostname: event.payload.hostname,
              project,
            });
          },
          projectId,
        });
      });
      return true;
    }
    case "events.iterate.com/project/custom-domain-remove-requested": {
      blockProcessorWhile(async () => {
        const hostname = event.payload.hostname;
        try {
          const domain = state.customDomains.find((candidate) => candidate.hostname === hostname);
          if (!domain) {
            throw new Error(`Custom domain "${hostname}" is not configured on this project.`);
          }
          const provisioner = assertCustomDomainProvisioner(customDomains);
          const project =
            (await provisioner.readProject()) ?? projectRecordFromState(state, projectId);
          await provisioner.remove({
            cloudflareHostnameId: domain.cloudflareHostnameId,
            hostname,
            project,
          });
          await append({
            type: "events.iterate.com/project/custom-domain-removed",
            idempotencyKey: `project/custom-domain-removed:${projectId}:${event.offset}`,
            payload: { hostname },
          });
        } catch (error) {
          await append({
            type: "events.iterate.com/project/custom-domain-provision-failed",
            idempotencyKey: `project/custom-domain-remove-failed:${projectId}:${event.offset}`,
            payload: { error: errorMessage(error), hostname },
          });
        }
      });
      return true;
    }
    default:
      return false;
  }
}

function assertCustomDomainProvisioner(
  provisioner: ProjectCustomDomainDeps | undefined,
): ProjectCustomDomainDeps {
  if (!provisioner) throw new Error("Custom-domain provisioning is not configured.");
  return provisioner;
}

function projectRecordFromState(
  state: { createRequest: { projectId: string; slug: string } | null },
  projectId: string,
): ProjectDirectoryRecord {
  const slug = state.createRequest?.slug ?? projectId;
  return { id: projectId, slug, organizationId: null, name: slug };
}

async function appendCustomDomainObservation(input: {
  append: (...input: EmittedInput<typeof ProjectProcessorContract>[]) => Promise<StreamEvent[]>;
  eventOffset: number;
  hostname: string;
  operation: () => Promise<ProjectCustomDomainCloudflareSnapshot>;
  projectId: string;
}): Promise<void> {
  try {
    const snapshot = await input.operation();
    await input.append({
      type: "events.iterate.com/project/custom-domain-cloudflare-observed",
      idempotencyKey: `project/custom-domain-observed:${input.projectId}:${input.eventOffset}`,
      payload: snapshot,
    });
  } catch (error) {
    await input.append({
      type: "events.iterate.com/project/custom-domain-provision-failed",
      idempotencyKey: `project/custom-domain-failed:${input.projectId}:${input.eventOffset}`,
      payload: { error: errorMessage(error), hostname: input.hostname },
    });
  }
}

function upsertCustomDomain<State extends { customDomains: ProjectCustomDomainState[] }>(
  state: State,
  domain: ProjectCustomDomainState,
): State {
  const next = [
    ...state.customDomains.filter((candidate) => candidate.hostname !== domain.hostname),
    domain,
  ].sort((a, b) => a.hostname.localeCompare(b.hostname));
  return { ...state, customDomains: next };
}

function markCustomDomainRemoving<State extends { customDomains: ProjectCustomDomainState[] }>(
  state: State,
  hostname: string,
  updatedAt: string,
): State {
  const domain = state.customDomains.find((candidate) => candidate.hostname === hostname);
  if (!domain) return state;
  return upsertCustomDomain(state, {
    ...domain,
    status: "removing",
    updatedAt,
  });
}

type ProjectCustomDomainState = ProjectCustomDomainCloudflareSnapshot & {
  createdAt: string;
  updatedAt: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
