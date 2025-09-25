// Very temporary script to build and publish the OS and SDK packages

import { execSync } from "node:child_process";
import * as fsp from "node:fs/promises";

await fsp.rm("./apps/os/dist", { recursive: true, force: true });
await fsp.mkdir("./apps/os/dist");

execSync("pnpm tsdown", { stdio: "inherit", cwd: "./apps/os" });
const packageJson = await fsp.readFile("./apps/os/package.json", "utf-8");
const packageJsonObj = JSON.parse(packageJson);

packageJsonObj.main = "./dist/index.js";
packageJsonObj.types = "./dist/index.d.ts";
packageJsonObj.exports = {
  "./sdk": "./dist/index.js",
};
packageJsonObj.files = ["./dist"];
delete packageJsonObj.private;

await fsp.writeFile("./apps/os/package.json", JSON.stringify(packageJsonObj, null, 2));

await fsp.rm("./packages/sdk/dist", { recursive: true, force: true });
await fsp.mkdir("./packages/sdk/dist");

execSync("pnpm tsdown", { stdio: "inherit", cwd: "./packages/sdk" });
const packageJson2 = await fsp.readFile("./packages/sdk/package.json", "utf-8");
const packageJsonObj2 = JSON.parse(packageJson2);

packageJsonObj2.main = "./dist/sdk.js";
packageJsonObj2.types = "./dist/sdk.d.ts";
packageJsonObj2.exports = {
  ".": "./dist/sdk.js",
};
packageJsonObj2.files = ["./dist"];
delete packageJsonObj2.private;

await fsp.writeFile("./packages/sdk/package.json", JSON.stringify(packageJsonObj2, null, 2));

// Only publish to pkg-pr in CI
if (process.env.GITHUB_REF) {
  execSync("pnpx pkg-pr-new publish --comment=off --bin --pnpm './apps/os' './packages/sdk'", {
    stdio: "inherit",
  });
}
