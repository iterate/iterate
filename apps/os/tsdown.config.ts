import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./sdk/index.ts"],
  outDir: "../../packages/sdk/dist",
  format: "esm",
  dts: true,
  clean: true,
  sourcemap: false,
  noExternal: (id) =>
    // almost everything is internal, so it gets bundled with the sdk. the exceptions need to be added as dependencies in the sdk package.json
    // this is different from tsdown's default behavior, which is to make all prod dependencies external
    !id.startsWith("zod/") && id !== "zod" && id !== "type-fest" && id !== "dedent",
});
