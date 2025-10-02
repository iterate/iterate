import { WebClient, type WebClientOptions } from "@slack/web-api";
import type { WebAPICallResult } from "@slack/web-api/dist/WebClient";
import dedent from "dedent";

class ThrowingSlackWebClient extends WebClient {
  override async apiCall(
    method: string,
    options: Record<string, unknown> = {},
  ): Promise<WebAPICallResult> {
    const result = await super.apiCall(method, options);
    if ("ok" in result && result.ok === false) {
      throw new Error(dedent`
        Slack API call to ${method} failed: ${result.error ?? "unknown_error"}
        Options: ${JSON.stringify(options, null, 2)}
        Response metadata: ${JSON.stringify(result.response_metadata, null, 2)}
      `);
    }
    return result;
  }
}

export const createSlackWebClient = (token?: string, options?: WebClientOptions): WebClient => {
  return new ThrowingSlackWebClient(token, options);
};
