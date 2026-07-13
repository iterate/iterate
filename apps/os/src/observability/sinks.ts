import type { WideLogSink } from "./wide-log.ts";

/** One structured object becomes one searchable Workers Observability log line. */
export const cloudflareWideLogSink: WideLogSink = (event) => {
  if (event.errors?.length || event.outcome === "server_error") {
    console.error(event);
    return;
  }
  console.log(event);
};
