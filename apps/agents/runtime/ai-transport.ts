import { RpcTarget } from "cloudflare:workers";

type ModelTransportStart =
  | {
      kind: "response";
      status: number;
      statusText: string;
      headers: [string, string][];
      hasBody: boolean;
    }
  | { kind: "stream" }
  | { kind: "value"; value: unknown };

/** The receiving end of the byte-only RPC bridge. */
export class AgentAiSink extends RpcTarget {
  readonly stream = new TransformStream<Uint8Array>();
  readonly writer = this.stream.writable.getWriter();
  #resolve!: (value: ModelTransportStart) => void;
  #reject!: (reason: unknown) => void;
  readonly started = new Promise<ModelTransportStart>((resolve, reject) => {
    this.#resolve = resolve;
    this.#reject = reject;
  });

  start(value: ModelTransportStart): void {
    this.#resolve(value);
  }
  write(bytes: Uint8Array): Promise<void> {
    return this.writer.write(bytes);
  }
  close(): Promise<void> {
    return this.writer.close();
  }
  error(message: string): Promise<void> {
    const error = new Error(message);
    this.#reject(error);
    return this.writer.abort(error);
  }
  abort(reason: unknown): Promise<void> {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.#reject(error);
    return this.writer.abort(error);
  }
}
