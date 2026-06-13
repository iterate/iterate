/**
 * Integration-ingress worker: one DO per integration type — the global
 * capture + routing-table host that gates inbound webhooks and forwards each
 * captured event to the owning project's account stream.
 */
export { IntegrationIngressDurableObject } from "~/domains/integrations/durable-objects/integration-ingress-durable-object.ts";

export default {
  fetch: () => Response.json({ worker: "os-integration-ingress" }, { status: 404 }),
};
