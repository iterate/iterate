import { IterateDurableObject, createProcessorHost } from "../../sdk.ts";
import type { GithubAiLinterConfig } from "./index.ts";
import { ReviewBotProcessor } from "./review-bot.ts";

/**
 * One stateful review-bot worker per GitHub connection. It serves no HTTP and
 * folds no application state; its durable processor checkpoint prevents a
 * project-worker deployment or eviction from duplicating review work.
 */
export function createGithubAiLinterWorker(
  config: GithubAiLinterConfig,
): new (...args: ConstructorParameters<typeof IterateDurableObject>) => IterateDurableObject {
  return class ReviewBotApp extends IterateDurableObject {
    #host = createProcessorHost({
      ctx: this.ctx,
      env: this.env,
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

    get processor() {
      return this.#host.wakeProcessor;
    }
  };
}

export {
  handleGithubPullRequestWebhook,
  mightWakePullRequestAgent,
  ReviewBotProcessor,
  ReviewBotProcessorContract,
} from "./review-bot.ts";
