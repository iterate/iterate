import { DockerClient } from "@docker/node-sdk";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { Readable } from "node:stream";
import tar from "tar-stream";

const imageTag = process.env.JONASLAND2_SANDBOX_IMAGE || "jonasland2-sandbox:local";
const sandboxDir = import.meta.dirname;
const jonasland2Dir = join(sandboxDir, "..");

async function addFile(pack: tar.Pack, sourcePath: string, nameInTar: string): Promise<void> {
  const data = await readFile(sourcePath);
  await new Promise<void>((resolve, reject) => {
    pack.entry({ name: nameInTar, mode: 0o644 }, data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function createBuildContextTar(): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  for (const file of ["Dockerfile", "package.json", "Caddyfile", "egress-server.mjs", "start.sh"]) {
    await addFile(pack, join(sandboxDir, file), file);
  }

  for (const file of [
    "apps/events-contract/package.json",
    "apps/events-contract/src/index.ts",
    "apps/events-service/package.json",
    "apps/events-service/src/otel-init.ts",
    "apps/events-service/src/router.ts",
    "apps/events-service/src/server.ts",
  ]) {
    await addFile(pack, join(jonasland2Dir, file), file);
  }
  pack.finalize();
  await once(pack, "end");
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const docker = await DockerClient.fromDockerConfig();

  try {
    const contextTar = await createBuildContextTar();

    const build = docker.imageBuild(Readable.toWeb(Readable.from(contextTar)), {
      dockerfile: "Dockerfile",
      tag: imageTag,
      pull: "true",
      rm: true,
      forcerm: true,
      version: "1",
    });

    for await (const message of build.messages()) {
      if (message.stream) process.stdout.write(message.stream);
      if (message.error) throw new Error(message.error);
      if (message.errorDetail?.message) throw new Error(message.errorDetail.message);
    }

    console.log(`Built image: ${imageTag}`);
  } finally {
    await docker.close();
  }
}

await main();
