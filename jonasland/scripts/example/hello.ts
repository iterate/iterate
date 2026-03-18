import { scriptCli } from "../_cli.ts";

export const helloScript = scriptCli
  .meta({
    description: "Say hello from the jonasland CLI",
  })
  .handler(async () => {
    return {
      ok: true,
      message: "hello",
    };
  });
