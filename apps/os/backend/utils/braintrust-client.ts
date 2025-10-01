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
  estateName: string;
}) {
  const { braintrustKey, projectName, spanName, estateName } = opts;
  const logger = getBraintrustLogger({ braintrustKey, projectName });
  const span = logger.startSpan({ name: spanName, type: "task" });
  span.log({ metadata: { estateName } });
  await span.flush();
  return await span.export();
}
