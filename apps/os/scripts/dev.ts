import { runDevServerCommand } from "./dev-server.ts";

runDevServerCommand(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
