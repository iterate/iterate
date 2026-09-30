// project/minimal-config.ts — THE CONFIG A PROJECT IS BORN WITH when its creation names no template:
// a homepage and nothing else. Every other template (iterate's agents and voice, a self-host's own) is
// the build's input (scripts/build.ts `--template`) or a creation's GitHub reference.

const worker = `import { IterateConfigEntrypoint, type IterateConfigProcessEventArgs } from "iterate/sdk";

export default class extends IterateConfigEntrypoint {
  // Every durable event of the project arrives here, the platform's project/worker-updated among
  // them after each commit of this repo: the place to install what the project runs.
  async processEvent(_args: IterateConfigProcessEventArgs) {}

  // Every host of the project, routed on \`x-iterate-routing-slug\`; the bare host is the homepage.
  async fetch(request: Request) {
    const routingSlug = request.headers.get("x-iterate-routing-slug");
    if (!routingSlug) {
      using itx = this.getItx();
      const { projectSlug } = await itx.whoami();
      return new Response("Homepage of project " + projectSlug + "\\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Not found\\n", { status: 404 });
  }
}
`;

export const MINIMAL_CONFIG_FILES = [
  {
    path: "package.json",
    content: `${JSON.stringify({ private: true, type: "module", main: "worker.ts" }, null, 2)}\n`,
  },
  { path: "worker.ts", content: worker },
];
