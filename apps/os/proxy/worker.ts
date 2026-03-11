import type { proxyWorker } from "../alchemy.run.ts";
export type ProxyWorkerBindings = typeof proxyWorker.Env;

export { ProjectIngressProxy } from "./project-ingress-proxy.ts";

export default {
  fetch(request: Request, env: ProxyWorkerBindings) {
    const domain = new URL(request.url).hostname;
    const doName = `proxy-${domain}`; // TODO: stable name
    const stub = env.PROJECT_INGRESS_PROXY.getByName(doName);
    return stub.fetch(request);
  },
};
