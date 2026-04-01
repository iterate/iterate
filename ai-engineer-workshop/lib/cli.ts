#!/usr/bin/env node
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { os } from "@orpc/server";
import { z } from "zod";
import { createCli, yamlTableConsoleLogger } from "trpc-cli";
import * as prompts from "@clack/prompts";
import { getFiles } from "./files.ts";

const files = getFiles();

const router = os.router({
  run: os
    .input(
      z.object({
        script: z.enum(
          fsSync.globSync("**/*.{js,ts,sh}", {
            cwd: process.cwd(),
            exclude: ["dist", "node_modules"],
          }),
        ),
      }),
    )
    .handler(async ({ input }) => {
      await import(path.join(process.cwd(), input.script));
    }),
  appendHelloWorld: getProcedure("01-hello-world/append-hello-world.ts"),
  openTmuxPanes: getProcedure("01-hello-world/open-tmux-panes.sh"),
  streamEvents: getProcedure("01-hello-world/stream-events.sh"),
  subscribeHelloWorld: getProcedure("01-hello-world/subscribe-hello-world.ts"),
  runLlmSubscriber: getProcedure("02-basic-llm-loop/run-llm-subscriber.ts"),
});

const cli = createCli({ router });

await cli.run({ prompts, logger: yamlTableConsoleLogger });

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
