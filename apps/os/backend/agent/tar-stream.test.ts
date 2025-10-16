import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { test } from "vitest";
import * as tarStream from "tar-stream";

test("tar-stream", { timeout: 5000 }, async () => {
  const extract = tarStream.extract();
  // Fetch the actual tarball, not the metadata
  const res = await fetch("https://registry.npmjs.org/zod/-/zod-4.0.1.tgz");
  console.log(`${res.status} ${res.statusText} ${res.url}`);

  // Stream directly from the response, pipe through gunzip to extract
  const nodeStream = Readable.fromWeb(res.body! as Parameters<typeof Readable.fromWeb>[0]);
  const gunzip = createGunzip();

  nodeStream.pipe(gunzip).pipe(extract);

  const tsFiles: Record<string, string> = {};

  for await (const entry of extract) {
    const filename = entry.header.name;

    if (filename.endsWith(".d.ts")) {
      // Read the content of the .ts file
      const chunks: Buffer[] = [];
      for await (const chunk of entry) {
        chunks.push(chunk);
      }
      const content = Buffer.concat(chunks).toString("utf-8");
      tsFiles[filename] = content;
      console.log(`Found .ts file: ${filename} (${content.length} bytes)`);
    } else {
      // Skip non-.ts files
      entry.resume();
    }
  }

  console.log(`Total .ts files found: ${Object.keys(tsFiles).length}`);
  console.log(Object.entries(tsFiles));
});
