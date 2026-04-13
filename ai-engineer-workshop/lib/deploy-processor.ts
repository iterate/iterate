import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DynamicWorkerConfiguredEventInput } from "../../apps/events-contract/src/dynamic-worker-types.ts";
import type { EventInput as EventInputType } from "../../apps/events-contract/src/types.ts";
import { buildDynamicWorkerConfiguredEvent } from "../../apps/events/src/durable-objects/dynamic-worker-bundler.ts";
import {
  createEventsClient,
  EventInput,
  type Event,
  type EventsORPCClient,
  type Processor,
} from "../sdk.ts";

type DeployProcessorEventsClient = Pick<EventsORPCClient, "append">;

export type DeployProcessorOptions = {
  baseUrl?: string;
  client?: DeployProcessorEventsClient;
  compatibilityFlags?: string[];
  eventJson?: string;
  file: string;
  outboundGateway?: boolean;
  processorExportName?: string;
  projectSlug?: string;
  slug?: string;
  streamPath: string;
};

export type DeployProcessorResult = {
  baseUrl?: string;
  configuredEvent: Event;
  configuredEventInput: DynamicWorkerConfiguredEventInput;
  file: string;
  outboundGateway: boolean;
  processorExportName: string;
  processorSlug: string;
  projectSlug?: string;
  seedEvent?: Event;
  seedEventInput?: EventInputType;
  streamPath: string;
};

export async function deployProcessor(
  args: DeployProcessorOptions,
): Promise<DeployProcessorResult> {
  const resolvedFile = resolve(args.file);
  const normalizedStreamPath = normalizeStreamPath(args.streamPath);
  const resolvedExport = await resolveProcessorExport({
    file: resolvedFile,
    preferredExportName: args.processorExportName,
  });
  const configuredEvent = await buildConfiguredEventFromProcessorFile({
    compatibilityFlags: args.compatibilityFlags,
    file: resolvedFile,
    outboundGateway: args.outboundGateway ?? true,
    processorExportName: resolvedExport.exportName,
    slug: args.slug ?? resolvedExport.processor.slug ?? slugFromFile(resolvedFile),
  });
  const seedEvent = args.eventJson == null ? undefined : parseEventJson(args.eventJson);
  const client =
    args.client ??
    createEventsClient({
      baseUrl: args.baseUrl,
      projectSlug: args.projectSlug,
    });

  const configuredResult = await client.append({
    path: normalizedStreamPath,
    event: configuredEvent,
  });
  const seedResult =
    seedEvent == null
      ? undefined
      : await client.append({
          path: normalizedStreamPath,
          event: seedEvent,
        });

  return {
    baseUrl: args.baseUrl,
    configuredEvent: configuredResult.event,
    configuredEventInput: configuredEvent,
    file: resolvedFile,
    outboundGateway: args.outboundGateway ?? true,
    processorExportName: resolvedExport.exportName,
    processorSlug: resolvedExport.processor.slug,
    projectSlug: args.projectSlug,
    seedEvent: seedResult?.event,
    seedEventInput: seedEvent,
    streamPath: normalizedStreamPath,
  };
}

export async function buildConfiguredEventFromProcessorFile(args: {
  compatibilityFlags?: string[];
  file: string;
  outboundGateway: boolean;
  processorExportName: string;
  slug: string;
}): Promise<DynamicWorkerConfiguredEventInput> {
  const wrapperDirectory = await mkdtemp(join(tmpdir(), "ai-engineer-workshop-deploy-processor-"));
  const wrapperFile = join(wrapperDirectory, "processor-entry.ts");

  try {
    await writeFile(
      wrapperFile,
      createProcessorWrapperSource({
        exportName: args.processorExportName,
        file: resolve(args.file),
      }),
    );

    return await buildDynamicWorkerConfiguredEvent({
      compatibilityFlags: args.compatibilityFlags,
      entryFile: wrapperFile,
      outboundGateway: args.outboundGateway
        ? {
            entrypoint: "DynamicWorkerEgressGateway",
          }
        : undefined,
      slug: args.slug,
    });
  } finally {
    await rm(wrapperDirectory, { force: true, recursive: true });
  }
}

export function createProcessorWrapperSource(args: { exportName: string; file: string }) {
  const importStatement =
    args.exportName === "default"
      ? `import processor from ${JSON.stringify(resolve(args.file))};`
      : `import { ${args.exportName} as processor } from ${JSON.stringify(resolve(args.file))};`;

  return [importStatement, "", "export default processor;", ""].join("\n");
}

export function parseEventJson(eventJson: string): EventInputType {
  let parsed: unknown;

  try {
    parsed = JSON.parse(eventJson);
  } catch (error) {
    throw new Error(
      `Failed to parse --event-json as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return EventInput.parse(parsed);
}

export async function resolveProcessorExport(args: {
  file: string;
  preferredExportName?: string;
}): Promise<{ exportName: string; processor: Processor<unknown> }> {
  const moduleExports = (await import(pathToFileURL(resolve(args.file)).href)) as Record<
    string,
    unknown
  >;

  if (args.preferredExportName != null) {
    const preferred = moduleExports[args.preferredExportName];
    if (!isProcessorLike(preferred)) {
      throw new Error(
        `Export "${args.preferredExportName}" from ${args.file} is not a processor-like object.`,
      );
    }

    return {
      exportName: args.preferredExportName,
      processor: preferred,
    };
  }

  const defaultExport = moduleExports.default;
  if (isProcessorLike(defaultExport)) {
    return {
      exportName: "default",
      processor: defaultExport,
    };
  }

  const candidates = Object.entries(moduleExports).flatMap(([exportName, value]) =>
    isProcessorLike(value) ? [{ exportName, processor: value }] : [],
  );

  if (candidates.length === 1) {
    const { exportName, processor } = candidates[0];
    return {
      exportName,
      processor,
    };
  }

  if (candidates.length === 0) {
    throw new Error(
      `No processor export found in ${args.file}. Add a default export, pass --processor-export-name, or export exactly one processor-like object.`,
    );
  }

  throw new Error(
    `Multiple processor exports found in ${args.file}: ${candidates.map(({ exportName }) => exportName).join(", ")}. Pass --processor-export-name.`,
  );
}

function isProcessorLike(value: unknown): value is Processor<unknown> {
  return (
    value != null && typeof value === "object" && "slug" in value && typeof value.slug === "string"
  );
}

function normalizeStreamPath(streamPath: string) {
  return streamPath.startsWith("/") ? streamPath : `/${streamPath}`;
}

function slugFromFile(file: string) {
  return basename(file).replace(/\.[^/.]+$/, "");
}
