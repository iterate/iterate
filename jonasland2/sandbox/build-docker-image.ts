import { DockerClient } from "@docker/node-sdk";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { Readable } from "node:stream";
import tar from "tar-stream";

const imageTag = process.env.JONASLAND2_SANDBOX_IMAGE || "jonasland2-sandbox:local";
const sandboxDir = import.meta.dirname;

async function addFile(pack: tar.Pack, name: string): Promise<void> {
  const data = await readFile(join(sandboxDir, name));
  await new Promise<void>((resolve, reject) => {
    pack.entry({ name, mode: 0o644 }, data, (error) => {
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

  await addFile(pack, "Dockerfile");
  await addFile(pack, "egress-server.mjs");
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
