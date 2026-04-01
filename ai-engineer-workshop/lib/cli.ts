#!/usr/bin/env node
import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";
import { os } from "@orpc/server";
import { z } from "zod";
import { createCli, yamlTableConsoleLogger } from "trpc-cli";
import * as prompts from "@clack/prompts";
import { getFiles } from "./files.ts";

const files = getFiles();
const scripts = await getScripts();
const username = process.env.WORKSHOP_USERNAME || execSync("id -un").toString().trim();

const router = os.router({
  run: os
    .input(
      z.object({
        script: scripts.length ? z.enum(scripts.map(({ file }) => file)) : z.string(),
      }),
    )
    .handler(async ({ input }) => {
      const script = scripts.find(({ file }) => file === input.script);
      if (!script) throw new Error(`Script ${input.script} not found`);
      await script._module.default(username);
    }),
  appendHelloWorld: getProcedure("01-hello-world/append-hello-world.ts"),
  openTmuxPanes: getProcedure("01-hello-world/open-tmux-panes.sh"),
  streamEvents: getProcedure("01-hello-world/stream-events.sh"),
  subscribeHelloWorld: getProcedure("01-hello-world/subscribe-hello-world.ts"),
  runLlmSubscriber: getProcedure("02-basic-llm-loop/run-llm-subscriber.ts"),
});

const cli = createCli({ router });

await cli.run({ prompts, logger: yamlTableConsoleLogger });

async function getScripts() {
  const files = await Array.fromAsync(
    fs.glob("**/*.{js,ts,sh}", {
      cwd: process.cwd(),
      exclude: ["dist", "node_modules"],
    }),
  );
  const withInfo = await Promise.all(
    files.map(async (file) => {
      const filepath = path.join(process.cwd(), file);
      const content = await fs.readFile(filepath, "utf8");
      if (!content.includes("export default")) {
        return { file, filepath, _module: {} };
      }
      const _module = await import(filepath).catch(() => ({}));
      return { file, filepath, _module };
    }),
  );
  return withInfo.filter(({ _module }) => typeof _module?.default === "function");
}

function getProcedure(key: keyof typeof files) {
  const value = files[key];
  const schema = z.object({
    name: z.string().describe("your name!"),
    path: z.string().describe("path to write the file to").default(key),
  });
  return os.input(schema).handler(async ({ input }) => {
    await fs.mkdir(path.dirname(input.path), { recursive: true });
    await fs.writeFile(input.path, replaceName(value, input.name));
    return { success: true, path: input.path };
  });
}

function replaceName(text: string, name: string) {
  return text
    .replaceAll("yourname", name)
    .replaceAll("jonas", name)
    .replaceAll("../../lib/sdk.ts", "ai-engineer-workshop");
}
