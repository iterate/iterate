import { describe, expect, it, vi } from "vitest";
import type { ProjectDirectoryRecord } from "../../project-directory.ts";
import type { Stream, StreamEvent, StreamEventInput } from "../../types.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import type { ProjectCustomDomainCloudflareSnapshot } from "./project-processor-contract.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";

class MemoryStream implements Stream {
  readonly events: StreamEvent[] = [];

  async __describe() {
    return { children: {}, instructions: "in-memory test stream", types: "" };
  }

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    return inputs.map((input) => {
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing) return existing;

      const event = {
        ...input,
        createdAt: new Date(this.events.length + 1).toISOString(),
        offset: this.events.length + 1,
      };
      this.events.push(event);
      return event;
    });
  }

  at(): Stream {
    return this;
  }

  async getEvent(
    input: { offset: number } | { idempotencyKey: string },
  ): Promise<StreamEvent | undefined> {
    if ("offset" in input) return this.events.find((event) => event.offset === input.offset);
    return this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
  }

  async getEvents(input: Parameters<Stream["getEvents"]>[0] = {}): Promise<StreamEvent[]> {
    const { afterOffset = 0, limit = 500 } = input;
    const beforeOffset = input.beforeOffset ?? Number.MAX_SAFE_INTEGER;
    return this.events
      .filter((event) => event.offset > afterOffset)
      .filter((event) => event.offset < beforeOffset)
      .filter(
        (event) =>
          input.eventTypes === undefined ||
          input.eventTypes.includes("*") ||
          input.eventTypes.includes(event.type),
      )
      .slice(0, limit);
  }

  readEvents(input: Parameters<Stream["readEvents"]>[0] = {}) {
    let afterOffset = input.afterOffset ?? 0;
    return {
      next: async () => {
        const page = await this.getEvents({ ...input, afterOffset });
        afterOffset = page.at(-1)?.offset ?? afterOffset;
        return page;
      },
      [Symbol.dispose]() {},
    };
  }

  async waitForEvent(input: Parameters<Stream["waitForEvent"]>[0]): Promise<StreamEvent> {
    const event = this.events.find((candidate) => {
      if (input.afterOffset !== undefined && candidate.offset <= input.afterOffset) return false;
      if (input.eventTypes !== undefined && !input.eventTypes.includes(candidate.type)) {
        return false;
      }
      return true;
    });
    if (event) return event;
    throw new Error("No matching event");
  }

  async getProcessorRuntimeState(): Promise<null> {
    return null;
  }

  async runtimeState() {
    return { coreProcessorState: null, runtime: { connections: {} } };
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
  }
}

const project: ProjectDirectoryRecord = {
  id: "prj_garple",
  name: "Garple",
  organizationId: "org_1",
  slug: "garple",
};

type CustomDomainDeps = NonNullable<
  ConstructorParameters<typeof ProjectProcessor>[0]["customDomains"]
>;

function customDomainSnapshot(
  input: Partial<ProjectCustomDomainCloudflareSnapshot> = {},
): ProjectCustomDomainCloudflareSnapshot {
  const hostname = input.hostname ?? "garple.com";
  return {
    cloudflareHostnameId: "custom-hostname-1",
    error: null,
    hostname,
    hostnameStatus: "active",
    ownershipVerification: {
      name: `_cf-custom-hostname.${hostname}`,
      value: "ownership-token",
    },
    sslStatus: "active",
    status: "active",
    validationRecords: [
      {
        name: `_acme-challenge.${hostname}`,
        status: "active",
        value: "ssl-token",
      },
    ],
    wildcard: true,
    ...input,
  };
}

function createHarness(overrides: Partial<CustomDomainDeps> = {}) {
  const stream = new MemoryStream();
  const customDomains: CustomDomainDeps = {
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
    ...overrides,
  };
  const processor = new ProjectProcessor({
    customDomains,
    defaultLlmProvider: "openai-ws",
    itx: {
      projectId: project.id,
      worker: { processEvent: vi.fn() },
    } as unknown as ConstructorParameters<typeof ProjectProcessor>[0]["itx"],
    stream,
  });
  const cursor = { offset: 0 };

  return {
    customDomains,
    deliver: async () => {
      const events = stream.events.slice(cursor.offset);
      cursor.offset = stream.events.length;
      if (events.length === 0) return;
      await processor.ingest({ events, streamMaxOffset: stream.events.length });
    },
    processor,
    stream,
  };
}

async function appendProjectEvent(
  stream: MemoryStream,
  input: Parameters<typeof ProjectProcessorContract.buildEvent>[0],
) {
  await stream.append(ProjectProcessorContract.buildEvent(input));
}

describe("ProjectProcessor custom domains", () => {
  it("provisions an add request and reduces the observed Cloudflare status", async () => {
    const harness = createHarness();

    await appendProjectEvent(harness.stream, {
      type: "events.iterate.com/project/custom-domain-add-requested",
      payload: { hostname: "garple.com" },
    });

    await harness.deliver();

    expect(harness.customDomains.ensure).toHaveBeenCalledWith({
      hostname: "garple.com",
      project,
    });
    expect(harness.stream.events.at(-1)).toMatchObject({
      type: "events.iterate.com/project/custom-domain-cloudflare-observed",
      payload: {
        cloudflareHostnameId: "custom-hostname-1",
        hostname: "garple.com",
        status: "pending_validation",
        wildcard: true,
      },
    });
    expect(harness.processor.state.customDomains).toMatchObject([
      {
        hostname: "garple.com",
        status: "requested",
      },
    ]);

    await harness.deliver();

    expect(harness.processor.state.customDomains).toMatchObject([
      {
        cloudflareHostnameId: "custom-hostname-1",
        hostname: "garple.com",
        status: "pending_validation",
        wildcard: true,
      },
    ]);
  });

  it("does not remove a custom domain that is absent from project state", async () => {
    const harness = createHarness();

    await appendProjectEvent(harness.stream, {
      type: "events.iterate.com/project/custom-domain-remove-requested",
      payload: { hostname: "garple.com" },
    });

    await harness.deliver();

    expect(harness.customDomains.remove).not.toHaveBeenCalled();
    expect(harness.stream.events.at(-1)).toMatchObject({
      type: "events.iterate.com/project/custom-domain-provision-failed",
      payload: {
        error: 'Custom domain "garple.com" is not configured on this project.',
        hostname: "garple.com",
      },
    });

    await harness.deliver();

    expect(harness.processor.state.customDomains).toEqual([]);
  });

  it("preserves the last Cloudflare snapshot when refresh fails", async () => {
    const harness = createHarness({
      refresh: vi.fn(async () => {
        throw new Error("Cloudflare is unavailable");
      }),
    });

    await appendProjectEvent(harness.stream, {
      type: "events.iterate.com/project/custom-domain-cloudflare-observed",
      payload: customDomainSnapshot(),
    });
    await harness.deliver();

    await appendProjectEvent(harness.stream, {
      type: "events.iterate.com/project/custom-domain-refresh-requested",
      payload: { hostname: "garple.com" },
    });
    await harness.deliver();
    await harness.deliver();

    expect(harness.processor.state.customDomains).toMatchObject([
      {
        cloudflareHostnameId: "custom-hostname-1",
        error: "Cloudflare is unavailable",
        hostname: "garple.com",
        status: "active",
      },
    ]);
  });
});
