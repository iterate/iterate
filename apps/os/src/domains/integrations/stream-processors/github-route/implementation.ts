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
      case "events.iterate.com/github/repo-route-configured": {
        const key = event.payload.fullName.toLowerCase();
        const existing = state.routes[key] ?? [];
        if (existing.includes(event.payload.repoStreamPath)) return state;
        return {
          ...state,
          routes: { ...state.routes, [key]: [...existing, event.payload.repoStreamPath] },
        };
      }
      case "events.iterate.com/github/repo-route-removed": {
        const key = event.payload.fullName.toLowerCase();
        const remaining =
          event.payload.repoStreamPath == null
            ? []
            : (state.routes[key] ?? []).filter((path) => path !== event.payload.repoStreamPath);
        if (remaining.length > 0) {
          return { ...state, routes: { ...state.routes, [key]: remaining } };
        }
        const { [key]: _removed, ...routes } = state.routes;
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
    const repoStreamPaths = state.routes[fullName.toLowerCase()] ?? [];
    if (repoStreamPaths.length === 0) return;

    // Fan out to EVERY linked repo. One idempotency key serves all
    // destinations — dedupe is per-stream.
    args.blockProcessorWhile(async () => {
      for (const repoStreamPath of repoStreamPaths) {
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
      }
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
