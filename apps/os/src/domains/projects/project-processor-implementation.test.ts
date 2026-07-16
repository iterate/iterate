import { describe, expect, it, vi } from "vitest";
import type { ProjectDirectoryRecord } from "../../project-directory.ts";
import { processCustomDomainEvent, reduceCustomDomainEvent } from "./custom-domain-processor.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import type { ProjectCustomDomainCloudflareSnapshot } from "./project-processor-contract.ts";

type CustomDomainReduceInput = Parameters<typeof reduceCustomDomainEvent>[0];
/** These tests always drive a REAL consumed event, never the event-less
 * at-head pass (`event: null`), so the harness works with the narrowed type. */
type CustomDomainEvent = NonNullable<Parameters<typeof processCustomDomainEvent>[0]["event"]>;

const project: ProjectDirectoryRecord = {
  id: "prj_garple",
  name: "Garple",
  organizationId: "org_1",
  slug: "garple",
};

function customDomainSnapshot(
  input: Partial<ProjectCustomDomainCloudflareSnapshot> = {},
): ProjectCustomDomainCloudflareSnapshot {
  const hostname = input.hostname ?? "garple.com";
  return {
    cloudflareHostnameId: "custom-hostname-1",
    error: null,
    hostname,
    hostnameStatus: "active",
    ownershipVerification: null,
    sslStatus: "active",
    status: "active",
    validationRecords: [],
    wildcard: true,
    ...input,
  };
}

function projectState(
  customDomains: CustomDomainReduceInput["state"]["customDomains"] = [],
): CustomDomainReduceInput["state"] {
  return {
    agents: [],
    birthCertificate: { config: { slug: project.slug } },
    customDomains,
    egressRules: [],
    humanApprovalKeys: [],
    onboardingActive: false,
    onboardingCompletedAt: null,
    repos: [],
    ready: true,
    secrets: [],
    streams: [],
  };
}

function event(
  input: Parameters<typeof ProjectProcessorContract.buildEvent>[0],
): CustomDomainEvent {
  return {
    ...ProjectProcessorContract.buildEvent(input),
    createdAt: "2026-01-01T00:00:00.000Z",
    offset: 1,
  } as CustomDomainEvent;
}

function processEventHarness(state = projectState()) {
  const appended: CustomDomainReduceInput["event"][] = [];
  const customDomains = {
    ensure: vi.fn(async () =>
      customDomainSnapshot({
        hostnameStatus: "pending",
        sslStatus: "pending_validation",
        status: "pending_validation",
      }),
    ),
    readProject: vi.fn(async () => project),
    refresh: vi.fn(async () => customDomainSnapshot()),
    remove: vi.fn(),
  };

  return {
    appended,
    customDomains,
    process: async (domainEvent: CustomDomainEvent) => {
      const pending: Array<Promise<unknown>> = [];
      const handled = processCustomDomainEvent({
        append: async (...inputs) => {
          const events = inputs.map((input, index) => ({
            ...ProjectProcessorContract.buildEvent(input),
            createdAt: "2026-01-01T00:00:01.000Z",
            offset: index + 2,
            path: "/projects/test",
          }));
          appended.push(...(events as CustomDomainReduceInput["event"][]));
          return events.map((event) => event.offset);
        },
        blockProcessorWhile: (task) => {
          pending.push(Promise.resolve(task()));
        },
        customDomains,
        event: domainEvent,
        idempotencyKey: (key) => `project/${key}@/projects/test:${domainEvent.offset}`,
        projectId: project.id,
        state,
      });
      await Promise.all(pending);
      return handled;
    },
  };
}

describe("ProjectProcessor custom domains", () => {
  it("provisions an add request and reduces the observed Cloudflare status", async () => {
    const addEvent = event({
      type: "events.iterate.com/project/custom-domain-add-requested",
      payload: { hostname: "garple.com" },
    });
    const addedState = reduceCustomDomainEvent({
      event: addEvent,
      state: projectState(),
    });
    const harness = processEventHarness(addedState ?? projectState());

    await expect(harness.process(addEvent)).resolves.toBe(true);

    expect(harness.customDomains.ensure).toHaveBeenCalledWith({
      hostname: "garple.com",
      project,
    });
    expect(harness.appended).toMatchObject([
      {
        type: "events.iterate.com/project/custom-domain-cloudflare-observed",
        payload: {
          cloudflareHostnameId: "custom-hostname-1",
          hostname: "garple.com",
          status: "pending_validation",
          wildcard: true,
        },
      },
    ]);
    expect(addedState?.customDomains).toMatchObject([
      {
        hostname: "garple.com",
        status: "requested",
      },
    ]);
    expect(
      reduceCustomDomainEvent({
        event: harness.appended[0]!,
        state: addedState ?? projectState(),
      })?.customDomains,
    ).toMatchObject([
      {
        cloudflareHostnameId: "custom-hostname-1",
        hostname: "garple.com",
        status: "pending_validation",
        wildcard: true,
      },
    ]);
  });

  it("preserves the last Cloudflare snapshot when refresh fails", async () => {
    const active = {
      ...customDomainSnapshot(),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const harness = processEventHarness(projectState([active]));
    harness.customDomains.refresh.mockRejectedValueOnce(new Error("Cloudflare is unavailable"));

    await expect(
      harness.process(
        event({
          type: "events.iterate.com/project/custom-domain-refresh-requested",
          payload: { hostname: "garple.com" },
        }),
      ),
    ).resolves.toBe(true);

    expect(harness.customDomains.refresh).toHaveBeenCalledWith({
      cloudflareHostnameId: "custom-hostname-1",
      hostname: "garple.com",
      project,
    });
    expect(
      reduceCustomDomainEvent({
        event: harness.appended[0]!,
        state: projectState([active]),
      })?.customDomains,
    ).toMatchObject([
      {
        cloudflareHostnameId: "custom-hostname-1",
        error: "Cloudflare is unavailable",
        hostname: "garple.com",
        status: "active",
      },
    ]);
  });
});
