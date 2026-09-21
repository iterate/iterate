// The virtual modules scripts/vite-plugin-processor-sdk.ts serves (vite.config.ts, vitest.config.ts).
declare module "virtual:processor-sdk" {
  /** The `iterate/next/sdk` bundle a loaded isolate imports as "./processor.js". */
  const source: string;
  export default source;
}
declare module "virtual:presence-processor-source" {
  /** The presence demo facet's modules, an author-shaped facet source. */
  const modules: { "cap.js": string };
  export default modules;
}
declare module "*.md" {
  const markdown: string;
  export default markdown;
}
