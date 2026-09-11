/** The isolated production-account domain proof; not an OS environment. */
export const projectCoreDomainPoc = {
  envName: "domain_poc",
  cloudflareAccountId: "04b3b57291ef2626c6a8daa9d47065a7",
  coreWorkerName: "iterate-project-core-domain-poc",
  bundlerWorkerName: "iterate-project-core-domain-bundler-poc",
  publicOrigin: "https://iterate2.com",
  projectHostnameBase: "iterate2.com",
  customHostnames: { "iterate.computer": "project-core-ingress-demo" },
  resources: {
    oauthKvId: "c3c1fc8d184c4aff8c3c990c7c71c122",
    buildCacheKvId: "9c24bcdfb1404bdd845ee8a617aa137e",
  },
  routes: [
    { pattern: "iterate2.com/*", zone_id: "403d3a21fb5d72c6295987a54b616bce" },
    { pattern: "*.iterate2.com/*", zone_id: "403d3a21fb5d72c6295987a54b616bce" },
    { pattern: "iterate.computer/*", zone_id: "f108cd9c1f7a7c44d2cc6ae3361035ef" },
    { pattern: "*.iterate.computer/*", zone_id: "f108cd9c1f7a7c44d2cc6ae3361035ef" },
  ],
} as const;
