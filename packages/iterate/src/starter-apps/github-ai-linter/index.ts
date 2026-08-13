import type { ItxBinding, StreamEvent } from "../../sdk.ts";
import {
  REVIEW_BOT_SUBSCRIPTION_NAME,
  reviewBotSubscriptionEvent,
  type GithubAiLinterConfig,
} from "./worker-ref.ts";

export type { GithubAiLinterConfig } from "./worker-ref.ts";

export const GithubAiLinter = {
  create(env: { ITX: ItxBinding }, config: GithubAiLinterConfig) {
    return {
      async processEvent(event: StreamEvent) {
        const linkedConnection =
          event.type === "events.iterate.com/repo/github-link-configured"
            ? event.payload?.connection
            : undefined;
        if (
          event.type === "events.iterate.com/repo/github-link-configured" &&
          (typeof linkedConnection !== "string" || !linkedConnection.length)
        ) {
          return;
        }
        if (
          event.type !== "events.iterate.com/repo/github-link-configured" &&
          (event.type !== "events.iterate.com/project/worker-updated" || event.path !== "/")
        ) {
          return;
        }

        using itx = await env.ITX.get();
        let connections: string[];
        if (typeof linkedConnection === "string") {
          connections = [linkedConnection];
        } else {
          const repos = await itx.repos.list();
          const links = await Promise.all(
            repos.map(
              async ({ path }) => (await itx.repos.get(path).processor.snapshot()).state.github,
            ),
          );
          connections = links.flatMap((link) => (link ? [link.connection] : []));
        }
        await Promise.all(
          [...new Set(connections)].map(async (connection) => {
            const connectionStream = itx.streams.get(`/integrations/github/${connection}`);
            const runtime = await connectionStream.runtimeState();
            const existingCondition =
              runtime.coreProcessorState.subscriptions.outbound.byName[REVIEW_BOT_SUBSCRIPTION_NAME]
                ?.configuration.filter?.jsonataCondition;
            // Both the original cutoff-only condition and the narrowed
            // condition start with this durable boundary. Keep accepting the
            // old shape so the first config refresh upgrades in place without
            // skipping webhooks which arrived since installation.
            const existingCutoffMatch = existingCondition?.match(/^offset > ([0-9]+)(?:\s|$)/);
            const existingCutoff = existingCutoffMatch ? Number(existingCutoffMatch[1]) : null;

            // First configuration deliberately starts at the current head: a
            // semantic project restore must not replay historical webhooks.
            // Later config-worker updates preserve that boundary so a refresh
            // cannot skip webhooks that arrived since the bot was installed.
            const startAfterOffset =
              Number.isFinite(existingCutoff) && Number.isSafeInteger(existingCutoff)
                ? existingCutoff
                : runtime.coreProcessorState.maxOffset;
            await connectionStream.append(
              await reviewBotSubscriptionEvent(event, connection, config, startAfterOffset),
            );
          }),
        );
      },
    };
  },
};
