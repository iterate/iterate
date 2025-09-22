import { createCli } from "trpc-cli";
import * as prompts from "@clack/prompts";
import { t } from "./config.ts";
import { checkoutEstateCommand } from "./commands/checkout-estate.ts";

const router = t.router({
  estate: { checkout: checkoutEstateCommand },
});

const cli = createCli({ router });

cli.run({ prompts });
