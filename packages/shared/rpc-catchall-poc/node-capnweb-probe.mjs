import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const requireFromOs = createRequire(`${repoRoot}/apps/os/package.json`);

const { Miniflare } = await import(pathToFileURL(requireFromOs.resolve("miniflare")).href);
const capnwebPath = requireFromOs.resolve("capnweb");
const { newWebSocketRpcSession } = await import(pathToFileURL(capnwebPath).href);
const esbuild = await import(pathToFileURL(requireFromOs.resolve("esbuild")).href);

const bundle = await esbuild.build({
  absWorkingDir: `${repoRoot}/apps/os`,
  bundle: true,
  entryPoints: [new URL("./src/entry.ts", import.meta.url).pathname],
  external: ["cloudflare:workers"],
  format: "esm",
  platform: "browser",
  plugins: [
    {
      name: "resolve-from-apps-os",
      setup(build) {
        build.onResolve({ filter: /^capnweb$/ }, () => ({ path: capnwebPath }));
      },
    },
  ],
  write: false,
});

const mf = new Miniflare({
  compatibilityDate: "2026-04-27",
  compatibilityFlags: ["nodejs_compat"],
  modules: true,
  script: bundle.outputFiles[0].text,
  workerLoaders: { LOADER: {} },
});

try {
  await mf.ready;

  const dynamicResponse = await mf.dispatchFetch("http://localhost/dynamic");
  const dynamicValue = await dynamicResponse.json();
  assertJsonEqual(dynamicValue, {
    args: [{ marker: "dynamic", text: "hi" }],
    path: ["slack", "chat", "postMessage"],
  });

  const response = await mf.dispatchFetch("http://localhost/capnweb", {
    headers: { Upgrade: "websocket" },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Expected websocket 101, got ${response.status}`);
  }

  response.webSocket.accept();
  using ctx = newWebSocketRpcSession(response.webSocket);
  const value = await ctx.slack.chat.postMessage({
    marker: "node-capnweb",
    text: "hi",
  });

  console.log(JSON.stringify(value));
  assertJsonEqual(value, {
    args: [{ marker: "node-capnweb", text: "hi" }],
    path: ["slack", "chat", "postMessage"],
  });
} finally {
  await mf.dispose();
}

function assertJsonEqual(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Unexpected result:\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`,
    );
  }
}
