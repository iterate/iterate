import { describe, expect, it } from "vitest";
import {
  adaptBundleForWorkerd,
  bareModuleSpecifiers,
  polyfillEsbuildNodeRequire,
  stubBareNpmExternals,
} from "./build-backend.ts";

describe("bareModuleSpecifiers", () => {
  it("finds import, require, and __require bare names", () => {
    const source = `
      import x from "https-proxy-agent";
      import { y } from "form-data";
      import "./local.js";
      import "cloudflare:workers";
      const z = require("agent-base");
      var w = __require("node:os");
      const rel = require("./rel.js");
    `;
    expect(bareModuleSpecifiers(source)).toEqual([
      "agent-base",
      "cloudflare:workers",
      "form-data",
      "https-proxy-agent",
      "node:os",
    ]);
  });
});

describe("stubBareNpmExternals", () => {
  it("adds class stubs and rewrites static imports", () => {
    const modules = {
      "bundle.js":
        'import Agent from "https-proxy-agent";\nimport "cloudflare:workers";\nimport { z } from "zod";\nexport default {};\n',
    };
    const out = stubBareNpmExternals(modules);
    expect(out["bundle.js"]).toContain('from "./.iterate-external/https-proxy-agent.js"');
    expect(out["bundle.js"]).toContain('from "zod"');
    expect(out[".iterate-external/https-proxy-agent.js"]).toContain("class IterateExternalStub");
    expect(out["https-proxy-agent"]).toBeUndefined();
  });

  it("leaves __require bare names for the polyfill table", () => {
    const modules = {
      "bundle.js": 'var Agent = __require("agent-base");\nexport default Agent;\n',
    };
    const out = stubBareNpmExternals(modules);
    expect(out["bundle.js"]).toContain('__require("agent-base")');
    expect(out[".iterate-external/agent-base.js"]).toContain("class IterateExternalStub");
  });
});

describe("polyfillEsbuildNodeRequire", () => {
  it("rewrites Dynamic require and only imports referenced builtins", () => {
    const helper = `var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var os = __require("node:os");
var Agent = __require("agent-base");
export default { os, Agent };
`;
    const withStubs = stubBareNpmExternals({ "bundle.js": helper });
    const out = polyfillEsbuildNodeRequire(withStubs);
    expect(out["bundle.js"]).toContain('import * as __iterate_node_os from "node:os"');
    expect(out["bundle.js"]).toContain("return __iterateNodeRequire(x)");
    expect(out["bundle.js"]).toContain("__iterateCjsInterop");
    expect(out["bundle.js"]).toContain("EventEmitter");
    expect(out["bundle.js"]).toContain('from "./.iterate-external/agent-base.js"');
    expect(out["bundle.js"]).toContain('"agent-base":');
    // Must not import the entire node builtin surface (OOM).
    expect(out["bundle.js"]).not.toContain("node:async_hooks");
    expect(out["bundle.js"]).not.toMatch(
      /throw Error\('Dynamic require of "' \+ x \+ '" is not supported'\)/,
    );
  });

  it("leaves modules without the helper untouched", () => {
    const modules = { "bundle.js": "export default {};\n" };
    expect(polyfillEsbuildNodeRequire(modules)).toBe(modules);
  });
});

describe("adaptBundleForWorkerd", () => {
  it("composes stub + polyfill", () => {
    const helper = `var __require = (function(x) {
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var os = __require("node:os");
var Agent = __require("https-proxy-agent");
export default { os, Agent };
`;
    const out = adaptBundleForWorkerd({ "bundle.js": helper });
    expect(out["bundle.js"]).toContain("return __iterateNodeRequire(x)");
    expect(out[".iterate-external/https-proxy-agent.js"]).toContain("class IterateExternalStub");
  });
});
