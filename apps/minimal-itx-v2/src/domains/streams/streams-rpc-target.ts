import { RpcTarget } from "cloudflare:workers";
import type { StreamsRpc } from "../../itx-types.ts";
import { StreamRpcTarget } from "./stream-durable-object.ts";

export class StreamsRpcTarget extends RpcTarget implements StreamsRpc {
  constructor(readonly projectId: string) {
    super();
  }

  get(path: string) {
    return new StreamRpcTarget({ path, projectId: this.projectId });
  }

  create({ path, ...input }: { path: string; [key: string]: unknown }) {
    return this.get(path).create(input);
  }
}
