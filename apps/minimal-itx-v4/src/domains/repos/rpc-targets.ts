import { env, RpcTarget } from "cloudflare:workers";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { durableObjectProcessorSubscriber } from "../streams/engine/shared/callable-subscriber.ts";
import { StreamRpcTarget } from "../streams/rpc-targets.ts";
import type { ItxAuth } from "../itx/types.ts";
import type { RpcTargetImplementation } from "../../rpc-target-types.ts";
import type { Stream } from "../streams/types.ts";
import type { Repo, RepoCollection } from "./types.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";

function normalizeRepoPath(path: string): string {
  return path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
}

function projectRootStream(props: { auth: ItxAuth; projectId: string }) {
  return new StreamRpcTarget({
    auth: props.auth,
    projectId: props.projectId,
    path: "/",
  });
}

export function repoProcessorSubscriptionEvent(input: { path: string; projectId: string }) {
  const path = normalizeRepoPath(input.path);
  return {
    type: "events.iterate.com/stream/subscription-configured",
    idempotencyKey: `stream-subscription:${input.projectId}:${RepoProcessorContract.slug}:${path}`,
    payload: {
      subscriptionKey: `${RepoProcessorContract.slug}:${path}`,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "REPO",
        durableObjectName: DurableObjectNameCodec.stringify({
          projectId: input.projectId,
          path,
        }),
        processorName: RepoProcessorContract.slug,
      }),
    },
  } satisfies Parameters<Stream["append"]>[0];
}

async function requestRepoCreate(input: {
  auth: ItxAuth;
  path: string;
  projectId: string;
}): Promise<RepoRpcTarget> {
  const path = normalizeRepoPath(input.path);
  const stream = projectRootStream({ auth: input.auth, projectId: input.projectId });
  const [, createRequested] = await stream.append(repoProcessorSubscriptionEvent(input), {
    type: "events.iterate.com/repo/create-requested",
    idempotencyKey: `repo-create-requested:${input.projectId}:${path}`,
    payload: { projectId: input.projectId, path },
  });

  await stream.waitForEvent({
    afterOffset: createRequested.offset - 1,
    eventTypes: ["events.iterate.com/repo/created"],
    predicate: (event) =>
      event.payload?.projectId === input.projectId && event.payload?.path === path,
    timeoutMs: 60_000,
  });

  return new RepoRpcTarget({ auth: input.auth, path, projectId: input.projectId });
}

export class RepoRpcTarget extends RpcTarget implements RpcTargetImplementation<Repo> {
  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get durableObjectStub() {
    return env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: normalizeRepoPath(this.props.path),
      }),
    );
  }

  create() {
    return requestRepoCreate({
      auth: this.props.auth,
      path: this.props.path,
      projectId: this.props.projectId,
    });
  }

  whoami() {
    return this.durableObjectStub.whoami();
  }

  commitFiles(input: Parameters<Repo["commitFiles"]>[0]) {
    return this.durableObjectStub.commitFiles(input);
  }
}

export class RepoCollectionRpcTarget
  extends RpcTarget
  implements RpcTargetImplementation<RepoCollection>
{
  constructor(readonly props: { auth: ItxAuth; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  create(input: Parameters<RepoCollection["create"]>[0]) {
    return requestRepoCreate({
      auth: this.props.auth,
      path: input.path,
      projectId: this.props.projectId,
    });
  }

  get(path: string) {
    return new RepoRpcTarget({
      auth: this.props.auth,
      path: normalizeRepoPath(path),
      projectId: this.props.projectId,
    });
  }
}
