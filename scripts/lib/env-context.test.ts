import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

test("native Node scripts can import and inspect Cloudflare API errors", () => {
  // Vitest transforms TypeScript; a native subprocess catches syntax that
  // Node cannot strip when preview's trpc-cli imports this module.
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { CloudflareApiError } from './env-context.ts';
       console.log(JSON.stringify(new CloudflareApiError('GET', '/workers', 404, { code: 10007 })));`,
    ],
    { cwd: import.meta.dirname, env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8" },
  );
  expect(JSON.parse(output)).toMatchObject({
    name: "CloudflareApiError",
    method: "GET",
    path: "/workers",
    status: 404,
    details: { code: 10007 },
  });
});
