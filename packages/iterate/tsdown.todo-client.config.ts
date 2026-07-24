import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "todo/client": "src/todo/client.tsx",
  },
  format: "esm",
  fixedExtension: true,
  platform: "browser",
  target: "es2022",
  deps: {
    alwaysBundle: ["@iterate-com/capnweb", "react", "react/jsx-runtime", "react-dom", "scheduler"],
  },
  dts: false,
  minify: true,
  sourcemap: false,
  clean: false,
});
