import config from "iterate:github-ai-linter-config";
import { createGithubAiLinterWorker } from "./worker.ts";

export const ReviewBotApp = createGithubAiLinterWorker(config);
