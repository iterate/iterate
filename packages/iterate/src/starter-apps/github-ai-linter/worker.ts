import { StreamProcessorDurableObject, type ProcessorHostDeps } from "../../sdk.ts";
import type { GithubAiLinterConfig } from "./index.ts";
import { GithubAiLinterProcessor, publishGithubAiLinterReview } from "./ai-linter.ts";
import { ReviewBotProcessor } from "./review-bot.ts";

/**
 * One stateful review-bot worker per GitHub connection. It serves no HTTP and
 * folds no application state; its durable processor checkpoint prevents a
 * project-worker deployment or eviction from duplicating review work. `alarm()`
 * and the `processor` wake door come from {@link StreamProcessorDurableObject};
 * `recovery` keeps its registered obligations alive across eviction.
 */
export function createGithubAiLinterWorker(
  config: GithubAiLinterConfig,
): new (
  ...args: ConstructorParameters<typeof StreamProcessorDurableObject>
) => StreamProcessorDurableObject {
  return class ReviewBotApp extends StreamProcessorDurableObject {
    protected readonly recovery = true;
    protected createProcessor(deps: ProcessorHostDeps) {
      return new ReviewBotProcessor({
        ...deps,
        config,
        getItx: () => this.env.ITX.get(),
      });
    }
  };
}

/**
 * One stateful processor host per pull-request child stream. The stream also
 * hosts the generic Agent processor; separate Durable Objects are intentional
 * because each processor owns its own checkpoint and runtime obligations.
 */
export function createPullRequestLinterWorker(): new (
  ...args: ConstructorParameters<typeof StreamProcessorDurableObject>
) => StreamProcessorDurableObject {
  return class GithubAiLinterApp extends StreamProcessorDurableObject {
    protected readonly recovery = true;
    protected createProcessor(deps: ProcessorHostDeps) {
      return new GithubAiLinterProcessor({
        ...deps,
        publishReview: async (analysis) => {
          using itx = await this.env.ITX.get();
          return await publishGithubAiLinterReview(itx, analysis);
        },
      });
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
