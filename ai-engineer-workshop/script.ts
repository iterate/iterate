import { os } from "@orpc/server";
import { createEventsClient } from "./sdk.ts";

export default os.handler(async () => {
  const client = createEventsClient();
  const streamPath = `${process.env.PATH_PREFIX}/hello-world`;

  const result = await client.append({
    path: streamPath,
    event: { type: "hello-world", payload: { message: "hello world" } },
  });

  console.log(JSON.stringify(result, null, 2));
});
