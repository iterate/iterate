import { RpcTarget } from "cloudflare:workers";
import type { Event, EventInput } from "@iterate-com/shared/streams/types";
import type { ProjectScopes } from "./iterate-context-capability.ts";
import type { AppContext } from "~/context.ts";
import {
  getStreamsCapability,
  type StreamAppendBatchInput,
  type StreamAppendInput,
  type StreamListChildrenInput,
  type StreamPathInput,
  type StreamReadInput,
  type StreamsCapability,
} from "~/domains/streams/entrypoints/streams-capability.ts";

type StreamsClient = Pick<
  StreamsCapability,
  "append" | "appendBatch" | "create" | "getState" | "list" | "listChildren" | "read"
>;

export type StreamAddressInput = string | { namespace: string; path: string };
type ProjectStreamAddressInput = string | { path: string };

export class RootStreamsCapability extends RpcTarget {
  constructor(private readonly input: { context: AppContext; scopes: ProjectScopes }) {
    super();
  }

  get(input: StreamAddressInput) {
    const address = parseStreamAddress(input);
    assertNamespaceAccess({
      namespace: address.namespace,
      scopes: this.input.scopes,
    });
    return new StreamCapability({
      context: this.input.context,
      namespace: () => address.namespace,
      path: address.path,
    });
  }
}

export class ProjectStreamsCapability extends RpcTarget {
  constructor(
    private readonly input: {
      context: AppContext;
      projectId: () => Promise<string> | string;
    },
  ) {
    super();
  }

  get(input: ProjectStreamAddressInput) {
    return new StreamCapability({
      context: this.input.context,
      namespace: () => this.projectId(),
      path: typeof input === "string" ? input : input.path,
    });
  }

  async append(input: StreamAppendInput) {
    return await (await this.streamCollectionClient()).append(input);
  }

  async appendBatch(input: StreamAppendBatchInput) {
    return await (await this.streamCollectionClient()).appendBatch(input);
  }

  async create(input: StreamPathInput) {
    return await (await this.streamCollectionClient()).create(input);
  }

  async getState(input: StreamPathInput) {
    return await (await this.streamCollectionClient()).getState(input);
  }

  async list() {
    return await (await this.streamCollectionClient()).list();
  }

  async listChildren(input: StreamListChildrenInput) {
    return await (await this.streamCollectionClient()).listChildren(input);
  }

  async read(input: StreamReadInput) {
    return await (await this.streamCollectionClient()).read(input);
  }

  private async streamCollectionClient(): Promise<StreamsClient> {
    return getStreamsCapability({
      exports: this.input.context.workerExports,
      props: {
        appendPolicy: { mode: "any" },
        projectId: await this.projectId(),
      },
    });
  }

  private async projectId() {
    return await this.input.projectId();
  }
}

export class StreamCapability extends RpcTarget {
  constructor(
    private readonly input: {
      context: AppContext;
      namespace: () => Promise<string> | string;
      path: string;
    },
  ) {
    super();
  }

  async append(event: EventInput): Promise<Event> {
    return await (await this.streamClient()).append({ event });
  }

  async appendBatch(events: EventInput[]): Promise<Event[]> {
    return await (await this.streamClient()).appendBatch({ events });
  }

  async describe() {
    return {
      namespace: await this.namespace(),
      path: this.input.path,
    };
  }

  async getState() {
    return await (await this.streamClient()).getState({});
  }

  async listChildren() {
    return await (await this.streamClient()).listChildren({});
  }

  async read(input: Omit<StreamReadInput, "streamPath"> = {}): Promise<Event[]> {
    return await (await this.streamClient()).read(input);
  }

  private async streamClient(): Promise<StreamsClient> {
    return getStreamsCapability({
      exports: this.input.context.workerExports,
      props: {
        appendPolicy: { mode: "stream" },
        projectId: await this.namespace(),
        streamPath: this.input.path,
      },
    });
  }

  private async namespace() {
    return await this.input.namespace();
  }
}

function parseStreamAddress(input: StreamAddressInput) {
  if (typeof input !== "string") return input;
  const separatorIndex = input.indexOf(":/");
  if (separatorIndex <= 0) {
    throw new Error(`Stream address must look like namespace:/path, received ${input}.`);
  }
  return {
    namespace: input.slice(0, separatorIndex),
    path: input.slice(separatorIndex + 1),
  };
}

function assertNamespaceAccess(input: { namespace: string; scopes: ProjectScopes }) {
  if (input.scopes.projects === "all") return;
  if (input.scopes.projects.includes(input.namespace)) return;
  throw new Error(`Missing namespace authority for ${input.namespace}.`);
}
