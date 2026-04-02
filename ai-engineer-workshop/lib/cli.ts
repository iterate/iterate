import * as fs from "node:fs/promises";
import * as path from "node:path";
import { os } from "@orpc/server";
import * as prompts from "@clack/prompts";
import { createCli, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod";
import { getFiles } from "./files.ts";
import { getDefaultWorkshopPathPrefix, normalizePathPrefix } from "./run-script.ts";

await main();

async function main() {
  const files = getFiles();
  const scripts = await getScripts();
  const router = os.router({
    run: os
      .input(
        z.object({
          script: scripts.length ? z.enum(scripts.map(({ file }) => file)) : z.string(),
          pathPrefix: z
            .string()
            .default(getDefaultWorkshopPathPrefix())
            .describe("stream path prefix, e.g. /jonas"),
        }),
      )
      .handler(async ({ input }) => {
        const script = scripts.find(({ file }) => file === input.script);
        if (!script) throw new Error(`Script ${input.script} not found`);
        await script.module.default(normalizePathPrefix(input.pathPrefix));
      }),
    appendHelloWorld: getProcedure(files, "01-hello-world/append-hello-world.ts"),
    openTmuxPanes: getProcedure(files, "01-hello-world/open-tmux-panes.sh"),
    streamEvents: getProcedure(files, "01-hello-world/stream-events.sh"),
    subscribeHelloWorld: getProcedure(files, "01-hello-world/subscribe-hello-world.ts"),
    runLlmSubscriber: getProcedure(files, "02-basic-llm-loop/run-llm-subscriber.ts"),
  });

  const cli = createCli({ router });
  await cli.run({ prompts, logger: yamlTableConsoleLogger });
}

async function getScripts() {
  const files = await Array.fromAsync(
    fs.glob("**/[0-9][0-9]-*/*.{js,ts,sh}", {
      cwd: process.cwd(),
      exclude: ["dist/**", "node_modules/**", "web/**"],
    }),
  );

  const withInfo = await Promise.all(
    files.map(async (file) => {
      const filepath = path.join(process.cwd(), file);
      const content = await fs.readFile(filepath, "utf8");
      if (!content.includes("export default")) {
        return { file, module: {} };
      }
      const module = await import(filepath).catch(() => ({}));
      return { file, module };
    }),
  );
  return withInfo.filter(({ module }) => typeof module?.default === "function");
}

function getProcedure(files: ReturnType<typeof getFiles>, key: keyof ReturnType<typeof getFiles>) {
  const value = files[key];
  const schema = z.object({
    path: z.string().describe("path to write the file to").default(key),
  });
  return os.input(schema).handler(async ({ input }) => {
    await fs.mkdir(path.dirname(input.path), { recursive: true });
    await fs.writeFile(input.path, value);
    return { success: true, path: input.path };
  });
}
