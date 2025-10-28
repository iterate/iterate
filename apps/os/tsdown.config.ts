import * as path from "node:path";
import { defineConfig } from "tsdown";

const sdkDir = path.join(import.meta.dirname, "../../packages/sdk");

export default defineConfig({
  entry: ["./sdk/index.ts"],
  outDir: "dist/sdk",
  format: "esm",
  dts: {
    resolve: ["type-fest"],
  },
  clean: true,
  sourcemap: false,
  nodeProtocol: true,
  copy: [
    {
      from: "dist/sdk",
      to: path.join(sdkDir, "dist"),
    },
  ],
  plugins: [
    {
      name: "iterate:remove-jsonata-side-effects",
      renderChunk(source, id) {
        const importStatement = `import "@mmkal/jsonata/sync";\n`;
        if (!source.includes(importStatement)) return;
        this.info(`Removing \`${importStatement}\` from ${id.fileName}`);
        return {
          code: source.replace(importStatement, ""),
        };
      },
    },
  ],
});
