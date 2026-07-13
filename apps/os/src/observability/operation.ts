import { runWideLog, wideLogger } from "./wide-log.ts";

export function runHttpWideLog<TResponse extends Response>(
  run: () => TResponse | Promise<TResponse>,
): Promise<TResponse> {
  return runWideLog({ kind: "http_request" }, async () => {
    const response = await run();
    wideLogger.setOutcome(
      response.status >= 500 ? "server_error" : response.status >= 400 ? "client_error" : "ok",
    );
    return response;
  });
}
