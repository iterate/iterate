import { ErrorCode, WebClient, type WebClientOptions } from "@slack/web-api";
import type { WebAPICallResult } from "@slack/web-api/dist/WebClient";

type SlackHttpError = Error & {
  code?: string;
  statusCode?: number;
};

const isSlackHttpError = (error: unknown): error is SlackHttpError => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as SlackHttpError;

  if (candidate.code === ErrorCode.HTTPError) {
    return true;
  }

  return typeof candidate.statusCode === "number" && candidate.statusCode !== 200;
};

class ThrowingSlackWebClient extends WebClient {
  override async apiCall(
    method: string,
    options: Record<string, unknown> = {},
  ): Promise<WebAPICallResult> {
    try {
      const result = await super.apiCall(method, options);

      if ("ok" in result && result.ok === false) {
        throw new Error(`Slack API call to ${method} failed: ${result.error ?? "unknown_error"}`);
      }

      return result;
    } catch (error) {
      if (isSlackHttpError(error)) {
        const statusMessage =
          error.statusCode !== undefined
            ? `HTTP status ${error.statusCode}`
            : "a non-200 HTTP response";

        throw new Error(`Slack API call to ${method} failed with ${statusMessage}`, {
          cause: error,
        });
      }

      throw error;
    }
  }
}

export const createSlackWebClient = (token?: string, options?: WebClientOptions): WebClient => {
  return new ThrowingSlackWebClient(token, options);
};
