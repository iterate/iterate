import { defineConfig } from "sqlfu";

export default defineConfig({
  db: "./.sqlfu/dev.sqlite",
  migrations: "./migrations",
  definitions: "./definitions.sql",
  queries: "./sql",
});
