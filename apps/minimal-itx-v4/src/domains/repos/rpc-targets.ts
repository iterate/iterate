import { env, RpcTarget } from "cloudflare:workers";
import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";
import { StreamRpcTarget } from "../streams/rpc-targets.ts";
import { subscriptionConfiguredEvent } from "../streams/subscription-event.ts";
import type { ItxAuth } from "../itx/types.ts";
import type { Repo, RepoCollection } from "./types.ts";
import { RepoProcessorContract } from "./repo-processor-contract.ts";

function projectRootStream(props: { auth: ItxAuth; projectId: string }) {
  return new StreamRpcTarget({
    auth: props.auth,
    projectId: props.projectId,
    path: "/",
  });
}

async function requestRepoCreate(input: {
  auth: ItxAuth;
  path: string;
  projectId: string;
}): Promise<RepoRpcTarget> {
  const path = normalizePath(input.path);
  const stream = projectRootStream({ auth: input.auth, projectId: input.projectId });
  const [, createRequested] = await stream.append(
    subscriptionConfiguredEvent({
      projectId: input.projectId,
      path,
      bindingName: "REPO",
      processorName: RepoProcessorContract.slug,
    }),
    {
      type: "events.iterate.com/repo/create-requested",
      idempotencyKey: `repo-create-requested:${input.projectId}:${path}`,
      payload: { projectId: input.projectId, path },
    },
  );

  await stream.waitForEvent({
    afterOffset: createRequested.offset - 1,
    eventTypes: ["events.iterate.com/repo/created"],
    predicate: (event) =>
      event.payload?.projectId === input.projectId && event.payload?.path === path,
    timeoutMs: 60_000,
  });

  return new RepoRpcTarget({ auth: input.auth, path, projectId: input.projectId });
}

export class RepoRpcTarget extends RpcTarget implements Repo {
  constructor(readonly props: { auth: ItxAuth; path: string; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get durableObjectStub() {
    return env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: normalizePath(this.props.path),
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

export class RepoCollectionRpcTarget extends RpcTarget implements RepoCollection {
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
      path: normalizePath(path),
      projectId: this.props.projectId,
    });
  }
}
