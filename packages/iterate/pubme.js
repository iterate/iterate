import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { createCli } from "trpc-cli";
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import * as prompts from "@clack/prompts";

const t = initTRPC.create();

const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8"));

const router = t.router({
  publish: t.procedure
    .input(
      z.object({
        version: z.string().describe(`Version to publish (current is "${packageJson.version}")`),
        skipCheckClean: z.boolean().describe("Skip checking for clean git status").default(false),
      }),
    )
    .mutation(async ({ input }) => {
      execSync(`npm whoami`);
      if (input.version !== packageJson.version) {
        execSync(`npm version ${input.version}`);
      }
      const confirm = await prompts.confirm({
        message: "When you've committed the version bump, confirm you want to publish",
      });
      if (confirm !== true) {
        return { success: false, reason: "User did not confirm" };
      }
      const status = execSync(`git status --porcelain`).toString().trim();
      if (status !== "" && !input.skipCheckClean) {
        return { success: false, reason: "Uncommitted changes:\n" + status };
      }
      let otp = await prompts.text({ message: "Enter your npm OTP" });
      otp = otp.trim();
      if (!otp.match(/^\d{6}$/)) {
        return { success: false, reason: "Invalid OTP: " + otp };
      }
      execSync(`npm publish --otp=${otp}`);
      return { success: true };
    }),
});

process.chdir(import.meta.dirname);

const cli = createCli({ router });
cli.run({ prompts });
