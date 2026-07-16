/**
 * Stable delimiters bounding an app's primary Worker upload.
 *
 * One app deployment may upload sidecars both before and after its public
 * Worker. Log consumers select only the output between the matching markers
 * instead of guessing that the first or last Wrangler result belongs to it.
 */
export const PRIMARY_WORKER_DEPLOY_START_MARKER = "::iterate-primary-worker-deploy:start::";
export const PRIMARY_WORKER_DEPLOY_END_MARKER = "::iterate-primary-worker-deploy:end::";

export function primaryWorkerDeployStartMarker(workerName: string): string {
  return `${PRIMARY_WORKER_DEPLOY_START_MARKER} ${workerName}`;
}

export function primaryWorkerDeployEndMarker(workerName: string): string {
  return `${PRIMARY_WORKER_DEPLOY_END_MARKER} ${workerName}`;
}

/** The bounded primary upload, or null when its delimiters are not identified exactly once. */
export function primaryWorkerDeployOutput(output: string): string | null {
  const markers = [
    ...output.matchAll(/^::iterate-primary-worker-deploy:(start|end):: ([^\r\n]+)$/gm),
  ];
  const [start, end] = markers;
  if (
    markers.length !== 2 ||
    !start ||
    !end ||
    start[1] !== "start" ||
    end[1] !== "end" ||
    start[2] !== end[2] ||
    start.index === undefined ||
    end.index === undefined
  ) {
    return null;
  }
  return output.slice(start.index + start[0].length, end.index);
}
