import { RpcTarget } from "cloudflare:workers";
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

export class ProjectStreamsCapability extends RpcTarget {
  constructor(private readonly input: { context: AppContext; projectId: string }) {
    super();
  }

  async append(input: StreamAppendInput) {
    return await this.streams().append(input);
  }

  async appendBatch(input: StreamAppendBatchInput) {
    return await this.streams().appendBatch(input);
  }

  async create(input: StreamPathInput) {
    return await this.streams().create(input);
  }

  async getState(input: StreamPathInput) {
    return await this.streams().getState(input);
  }

  async list() {
    return await this.streams().list();
  }

  async listChildren(input: StreamListChildrenInput) {
    return await this.streams().listChildren(input);
  }

  async read(input: StreamReadInput) {
    return await this.streams().read(input);
  }

  private streams(): StreamsClient {
    return getStreamsCapability({
      exports: this.input.context.workerExports,
      props: {
        appendPolicy: { mode: "any" },
        projectId: this.input.projectId,
      },
    });
  }
}
