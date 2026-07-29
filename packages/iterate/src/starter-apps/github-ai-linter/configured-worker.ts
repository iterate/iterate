import config from "iterate:github-ai-linter-config";
import { createGithubAiLinterWorker, createPullRequestLinterWorker } from "./worker.ts";

export const ReviewBotApp = createGithubAiLinterWorker(config);
export const GithubAiLinterApp = createPullRequestLinterWorker();
