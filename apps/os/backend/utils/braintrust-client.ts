import { initLogger } from "braintrust/browser";

export function getBraintrustLogger(opts: { braintrustKey: string; projectName?: string }) {
  const { braintrustKey, projectName } = opts;
  return initLogger({
    projectName,
    apiKey: braintrustKey,
  });
}

export async function makeBraintrustSpan(opts: {
  braintrustKey: string;
  projectName: string;
  spanName: string;
}) {
  const { braintrustKey, projectName, spanName } = opts;
  const logger = getBraintrustLogger({ braintrustKey, projectName });
  const span = logger.startSpan({ name: spanName, type: "task" });
  await span.flush();
  return await span.export();
}
