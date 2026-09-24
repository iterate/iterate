import captunWorker, { CaptunServerShard } from "captun/worker";
import type { CaptunEnv } from "captun/worker";

/**
 * Public Captun gateway for `*.tunnels.iterate.com`.
 *
 * The worker name and class name deliberately match the existing production
 * service so deployment reconciles its live CaptunServerShard namespace rather
 * than creating a replacement namespace.
 */
export { CaptunServerShard };

export default {
  fetch(request: Request, env: CaptunEnv) {
    return captunWorker.fetch(request, env);
  },
};
