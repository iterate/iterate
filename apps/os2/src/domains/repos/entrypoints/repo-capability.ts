import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import type { RepoDurableObject } from "../durable-objects/repo-durable-object.ts";

type RepoCapabilityEnv = {
  REPO?: DurableObjectNamespace<RepoDurableObject>;
};

type RepoCapabilityProps = {
  projectId?: string;
};

export class RepoCapability extends WorkerEntrypoint<RepoCapabilityEnv, RepoCapabilityProps> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.join(".") !== "get") {
      throw new Error(`RepoCapability does not implement ${input.functionPath.join(".")}`);
    }
    if (!this.env.REPO) {
      throw new Error("REPO Durable Object namespace is not configured.");
    }

    const [{ slug }] = input.args as [{ slug?: string }];
    const projectId = requireProjectId(this.ctx.props);
    return new RepoHandle(this.env.REPO.getByName(`${projectId}:${slug ?? "default"}`));
  }
}

class RepoHandle extends RpcTarget {
  readonly #repo: DurableObjectStub<RepoDurableObject>;

  constructor(repo: DurableObjectStub<RepoDurableObject>) {
    super();
    this.#repo = repo;
  }

  /**
   * This handle deliberately forwards to the Durable Object rather than
   * exposing the namespace-generated DO stub itself. Workers RPC documents
   * `RpcTarget` instances and received RPC stubs as passable live values; the
   * facade keeps that live shape while the DO address stays private capability
   * state inside the provider.
   */
  async proofOfConcept(input: { callback?: (args: unknown) => unknown; message?: string }) {
    return await this.#repo.proofOfConcept(input);
  }
}

function requireProjectId(props: RepoCapabilityProps | undefined) {
  const projectId = props?.projectId;
  if (!projectId) throw new Error("RepoCapability requires ctx.props.projectId.");
  return projectId;
}
