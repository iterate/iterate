import * as fs from "node:fs";
import * as path from "node:path";
import { defineConfig } from "tsdown";
import type { PackageJson } from "type-fest";

// this is weird. everything interesting goes on in this package. we build the sdk package from here.
// the sdk package struggles to get the types right, because the .ts files live here.
// tsdown can't handle `export * from '@iterate-com/os'` yet I guess.

// we don't need to publish the os package for now.

const sdkDir = path.join(import.meta.dirname, "../../packages/sdk");

const sdkPackageJson: PackageJson = JSON.parse(
  fs.readFileSync(path.join(sdkDir, "package.json"), "utf-8"),
);

export default defineConfig({
  entry: ["./sdk/index.ts"],
  outDir: path.join(sdkDir, "dist"),
  format: "esm",
  dts: true,
  clean: true,
  sourcemap: false,
  noExternal: (id) => {
    const packageNameWithoutSubmodule = id.startsWith("@")
      ? id.split("/").slice(0, 2).join("/")
      : id.split("/")[0];
    // we want almost everything to be internal, so it gets bundled with the sdk. the exceptions need to be added as dependencies in the sdk package.json
    // this is different from tsdown's default behavior, which is to make all prod dependencies external
    const isExternal = packageNameWithoutSubmodule in (sdkPackageJson.dependencies || {});
    return !isExternal;
  },
});
