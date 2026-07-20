import { describe, expect, it } from "vitest";
import { bareModuleSpecifiers, stubBareNpmExternals } from "./build-backend.ts";

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
  it("adds stub modules for leftover npm bare imports", () => {
    const modules = {
      "bundle.js":
        'import Agent from "https-proxy-agent";\nimport "cloudflare:workers";\nexport default {};\n',
    };
    const out = stubBareNpmExternals(modules);
    expect(out["https-proxy-agent"]).toContain("export default");
    expect(out["bundle.js"]).toBe(modules["bundle.js"]);
    // Runtime modules stay external — no stub entry.
    expect(out["cloudflare:workers"]).toBeUndefined();
  });

  it("does not stub bare node builtins that nodejs_compat provides", () => {
    const modules = {
      "bundle.js": 'import fs from "fs";\nimport path from "path";\nimport "stream/promises";\n',
    };
    const out = stubBareNpmExternals(modules);
    expect(out["fs"]).toBeUndefined();
    expect(out["path"]).toBeUndefined();
    expect(out["stream/promises"]).toBeUndefined();
  });

  it("does not overwrite an already-present module key", () => {
    const modules = {
      "bundle.js": 'import x from "form-data";\n',
      "form-data": "export default 'real';\n",
    };
    const out = stubBareNpmExternals(modules);
    expect(out["form-data"]).toBe("export default 'real';\n");
  });
});
