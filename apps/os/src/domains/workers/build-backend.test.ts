import { describe, expect, it } from "vitest";
import {
  bareModuleSpecifiers,
  polyfillEsbuildNodeRequire,
  stubBareNpmExternals,
} from "./build-backend.ts";

describe("bareModuleSpecifiers", () => {
  it("finds import and require bare names and ignores relatives", () => {
    const source = `
      import x from "https-proxy-agent";
      import { y } from "form-data";
      import "./local.js";
      import "cloudflare:workers";
      const z = require("agent-base");
      const rel = require("./rel.js");
    `;
    expect(bareModuleSpecifiers(source)).toEqual([
      "agent-base",
      "cloudflare:workers",
      "form-data",
      "https-proxy-agent",
    ]);
  });
});

describe("stubBareNpmExternals", () => {
  it("rewrites allow-listed leftover npm bare imports to relative stubs", () => {
    const modules = {
      "bundle.js":
        'import Agent from "https-proxy-agent";\nimport "cloudflare:workers";\nimport { z } from "zod";\nexport default {};\n',
    };
    const out = stubBareNpmExternals(modules);
    expect(out["bundle.js"]).toContain('from "./.iterate-external/https-proxy-agent.js"');
    expect(out["bundle.js"]).toContain('from "zod"'); // intentional external stays
    expect(out["bundle.js"]).toContain('import "cloudflare:workers"');
    expect(out[".iterate-external/https-proxy-agent.js"]).toContain("export default");
    expect(out[".iterate-external/https-proxy-agent.js"]).toContain("class IterateExternalStub");
    // Never invent bare package-name module keys.
    expect(out["https-proxy-agent"]).toBeUndefined();
    expect(out["zod"]).toBeUndefined();
  });

  it("does not touch node builtins or unlisted packages", () => {
    const modules = {
      "bundle.js": 'import fs from "fs";\nimport path from "path";\nimport "stream/promises";\n',
    };
    expect(stubBareNpmExternals(modules)).toEqual(modules);
  });

  it("does not overwrite an already-present module key", () => {
    const modules = {
      "bundle.js": 'import x from "form-data";\n',
      "form-data": "export default 'real';\n",
    };
    const out = stubBareNpmExternals(modules);
    expect(out["form-data"]).toBe("export default 'real';\n");
    expect(out["bundle.js"]).toBe(modules["bundle.js"]);
  });
});

describe("polyfillEsbuildNodeRequire", () => {
  it("rewrites esbuild's Dynamic require helper to serve node: builtins", () => {
    const helper = `var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var os = __require("node:os");
export default os;
`;
    const out = polyfillEsbuildNodeRequire({ "bundle.js": helper });
    expect(out["bundle.js"]).toContain('import * as __iterate_node_os from "node:os"');
    expect(out["bundle.js"]).toContain("return __iterateNodeRequire(x)");
    expect(out["bundle.js"]).toContain("__iterateCjsInterop");
    expect(out["bundle.js"]).toContain("EventEmitter");
    expect(out["bundle.js"]).not.toMatch(
      /throw Error\('Dynamic require of "' \+ x \+ '" is not supported'\)/,
    );
  });

  it("leaves modules without the helper untouched", () => {
    const modules = { "bundle.js": "export default {};\n" };
    expect(polyfillEsbuildNodeRequire(modules)).toBe(modules);
  });
});
