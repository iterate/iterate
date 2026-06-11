declare module "*.svg" {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  readonly SSR: boolean;
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
