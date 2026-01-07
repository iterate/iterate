import { join } from "node:path";
import { Daytona, Image } from "@daytonaio/sdk";

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
});

const snapshot = await daytona.snapshot.create(
  {
    name: `iterate-sandbox-0.0.1-dev`,
    image: Image.fromDockerfile(join(import.meta.dirname, "./Dockerfile")),
  },
  {
    onLogs: console.log,
  },
);

console.log(snapshot);
