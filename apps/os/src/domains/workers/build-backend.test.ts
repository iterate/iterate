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
