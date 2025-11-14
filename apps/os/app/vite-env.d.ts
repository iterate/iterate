/// <reference types="vite/client" />

interface ViteTypeOptions {
  strictImportMetaEnv: true;
}

type FullEnv = (typeof import("../alchemy.run").worker)["Env"];
type ViteEnv = {
  [K in keyof FullEnv as Extract<K, `VITE_${string}`>]: FullEnv[K];
};

interface ImportMetaEnv extends ViteEnv {}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../backend/worker");
    durableNamespaces: "IterateAgent";
  }
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/index");
    durableNamespaces: "ClientDO";
  }
  interface Env {}
}
