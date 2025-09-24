import { createCli } from "trpc-cli";
import * as prompts from "@clack/prompts";
import { t } from "./config.ts";
import { estate } from "./commands/checkout-estate.ts";
import { gh } from "./commands/gh-commands.ts";

const router = t.router({
  estate,
  gh,
});

const cli = createCli({ router });

cli.run({ prompts });
