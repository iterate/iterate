/** `blob:` cannot resolve root-relative assets, so qualify them against the worker origin. */
export function resolveWorkerAssetUrl(assetUrl: string, workerOrigin: string): string {
  return new URL(assetUrl, workerOrigin).href;
}
