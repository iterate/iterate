// Implements the "github-route" processor (contract.ts): fold the declared
// repository links, forward matching webhook envelopes to the repo streams.
// Forwarding BLOCKS the checkpoint (the router lesson): an event can't be
// checkpointed past until its copy landed on the repo stream.

import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import {
  assertNever,
  buildProcessorIdempotencyKey,
} from "@iterate-com/streams/shared/stream-processors";
import { GithubRouteProcessorContract, type GithubRouteProcessorState } from "./contract.ts";
export { GithubRouteProcessorContract } from "./contract.ts";

export type GithubRouteProcessorContract = typeof GithubRouteProcessorContract;

export class GithubRouteProcessor extends StreamProcessor<GithubRouteProcessorContract> {
  readonly contract = GithubRouteProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<GithubRouteProcessorContract>["reduce"]>[0],
  ): GithubRouteProcessorState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/github/repo-route-configured":
        return {
          ...state,
          routes: {
            ...state.routes,
            [event.payload.fullName.toLowerCase()]: event.payload.repoStreamPath,
          },
        };
      case "events.iterate.com/github/repo-route-removed": {
        const { [event.payload.fullName.toLowerCase()]: _removed, ...routes } = state.routes;
        return { ...state, routes };
      }
      case "events.iterate.com/integration/event-received":
        return state;
      default:
        return assertNever(event);
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<GithubRouteProcessorContract>["processEvent"]>[0],
  ): void {
    const { event, state } = args;
    if (event.type !== "events.iterate.com/integration/event-received") return;

    const fullName = githubRepositoryFullName(event.payload.body);
    if (fullName == null) return;
    const repoStreamPath = state.routes[fullName.toLowerCase()];
    if (repoStreamPath == null) return;

    args.blockProcessorWhile(async () => {
      await this.ctx.stream.append({
        streamPath: repoStreamPath,
        event: {
          type: "events.iterate.com/integration/event-received",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: this.contract,
            key: "forward",
            sourceEvent: event,
          }),
          payload: event.payload,
        },
      });
    });
  }
}

function githubRepositoryFullName(body: unknown): string | null {
  const repository =
    body != null && typeof body === "object"
      ? (body as { repository?: { full_name?: unknown } }).repository
      : undefined;
  return typeof repository?.full_name === "string" ? repository.full_name : null;
}
