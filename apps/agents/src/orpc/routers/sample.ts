import { os } from "~/orpc/orpc.ts";

export const sampleRouter = {
  hello: os.hello.handler(async ({ input }) => ({
    message: `hello ${input.name}`,
  })),
  fetchExample: os.fetchExample.handler(async () => {
    const response = await fetch("https://example.com/");

    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      body: await response.text(),
    };
  }),
};
