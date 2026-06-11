import captunWorker, { CaptunServerShard } from "captun/worker";
import type { CaptunEnv } from "captun/worker";

// The iterate tunnel gateway: a thin standalone wrapper around captun/worker.
//
// Serves `<name>.tunnels.iterate.com` — any dev environment, agent, or test
// can mint a named (or random) public tunnel in ~200ms by dialing the gateway
// with the shared Gateway Secret (`CAPTUN_TOKEN`, in Doppler). Deliberately
// NOT embedded in the OS worker: the gateway must stay tiny (fast cold
// starts) and outlive any single app deployment.
//
// Env (Doppler project `tunnels`):
// - CAPTUN_TOKEN      gateway secret; clients pass it as their connect token
// - CUSTOM_HOSTNAME   tunnels.iterate.com (enables subdomain addressing)
// - SHARD_COUNT       tunnels-per-DO spread (1 = lowest latency)

export { CaptunServerShard };

export default {
  fetch(request: Request, env: CaptunEnv) {
    return captunWorker.fetch(request, env);
  },
};
