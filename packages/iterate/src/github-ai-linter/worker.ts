import { IterateDurableObject, createProcessorHost } from "../sdk.ts";
import type { GithubAiLinterConfig } from "./index.ts";
import { ReviewBotProcessor } from "./review-bot.ts";

// The review bot's stateful host, one Durable Object instance per GitHub
// connection (the app ref's durableWorkerKey carries the connection slug). No
// fixed `path`: the host learns its connection stream from the first wake
// request. It serves no HTTP and holds no live state; it exists purely to put
// ReviewBotProcessor on the stream's delivery spine.
export function createGithubAiLinterWorker(
  config: GithubAiLinterConfig,
): new (...args: ConstructorParameters<typeof IterateDurableObject>) => IterateDurableObject {
  return class ReviewBotApp extends IterateDurableObject {
    #host = createProcessorHost({
      ctx: this.ctx,
      env: this.env,
      // Keepalive recovery: if an eviction kills this object while it owes
      // work, the alarm fires and the recovered runner gets its delivery turn.
      recovery: true,
      createProcessor: (deps) =>
        new ReviewBotProcessor({
          ...deps,
          config,
          getItx: () => this.env.ITX.get(),
        }),
    });

    async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
      await this.#host.handleAlarm(alarmInfo);
    }

    /** The wake door the stream spine dials — the subscription's persisted
     * expression is `workers.get(ref).processor.wakeStreamSubscriber`. */
    get processor() {
      return this.#host.wakeSubscriber;
    }
  };
}

export {
  handleGithubPullRequestWebhook,
  ReviewBotProcessor,
  ReviewBotProcessorContract,
  reviewBotFreshnessHorizonMs,
} from "./review-bot.ts";
