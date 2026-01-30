import { defineConfig } from "pidnap";

export default defineConfig({
  processes: [
    {
      name: "opencode",
      definition: {
        command: "bash",
        args: ["-c", `opencode serve --hostname 0.0.0.0 --port 4096`],
      },
    },
  ],
});
