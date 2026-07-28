import { defineConfig } from "tsdown";

const clientConfig = {
  format: "esm" as const,
  fixedExtension: true,
  platform: "browser" as const,
  target: "es2022",
  deps: {
    alwaysBundle: ["@iterate-com/capnweb", "react", "react/jsx-runtime", "react-dom", "scheduler"],
  },
  dts: false,
  minify: true,
  sourcemap: false,
  clean: false,
};

export default defineConfig([
  {
    ...clientConfig,
    entry: { "starter-apps/guestbook/client": "src/starter-apps/guestbook/client.tsx" },
  },
  {
    ...clientConfig,
    entry: { "starter-apps/todo/client": "src/starter-apps/todo/client.tsx" },
  },
]);
