import { IterateDurableObject, createProcessorHost } from "../../sdk.ts";
import type { GithubAiLinterConfig } from "./index.ts";
import { GithubAiLinterProcessor, publishGithubAiLinterReview } from "./ai-linter.ts";
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

/**
 * One stateful processor host per pull-request child stream. The stream also
 * hosts the generic Agent processor; separate Durable Objects are intentional
 * because each processor owns its own checkpoint and runtime obligations.
 */
export function createPullRequestLinterWorker(): new (
  ...args: ConstructorParameters<typeof IterateDurableObject>
) => IterateDurableObject {
  return class GithubAiLinterApp extends IterateDurableObject {
    #host = createProcessorHost({
      ctx: this.ctx,
      env: this.env,
      recovery: true,
      createProcessor: (deps) =>
        new GithubAiLinterProcessor({
          ...deps,
          publishReview: async (analysis) => {
            using itx = await this.env.ITX.get();
            return await publishGithubAiLinterReview(itx, analysis);
          },
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

export { GithubAiLinterProcessor, publishGithubAiLinterReview } from "./ai-linter.ts";
export { GithubAiLinterProcessorContract, githubAiLinterEventTypes } from "./contract.ts";
export {
  handleGithubPullRequestWebhook,
  mightWakePullRequestAgent,
  ReviewBotProcessor,
  ReviewBotProcessorContract,
} from "./review-bot.ts";
