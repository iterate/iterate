declare module "*.svg" {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  readonly SSR: boolean;
  readonly DEV: boolean;
  /** Vite's `base`: apps/base-path.ts reads a dev server's under a tunnel. */
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
