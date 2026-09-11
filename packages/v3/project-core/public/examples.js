// Displayed examples use the current Scope contract unless explicitly marked proposed.
export const examples = [
  `class Greeting extends RpcTarget {
  hello(name) { return "Hello, " + name; }
}
using mount = await scope.provide("greeting", new Greeting());
await scope.invoke(["greeting", "hello"], "Ada");
// This live browser-owned object disappears when its owner disconnects.`,

  `const review = scope.cd("/workspaces/review");
await review.inspect();
// { context: { project, path: "/workspaces/review", name }, ... }
// Context placement is private. App document paths need not allocate a DO.`,

  `await scope.append({
  id: crypto.randomUUID(), type: "note.created", data: { text: "Hello" },
});
using follow = await scope.subscribe(page => render(page.events));
// The public WebSocket protocol ACKs each page before sending the next.
// The Scope subscription adapter does this after the callback resolves.`,

  `await scope.append({
  id: "review-42", type: "review.accepted", data: { revision },
  provenance: { parents: ["edit-41"], signatures: [author, reviewer] },
});
// Each signature covers the same claims AND full project/context name.
// verification.level/signers/policyOffset are stamped by the platform.
// Try “Add this browser's signature” in the live console below.`,

  `await scope.append({
  id: crypto.randomUUID(), type: "itx.set",
  data: { key: "processor/notes", value: {
    source: { modules: { "main.js": workerSource } },
    exportName: "default", consumes: ["note.created"], afterOffset: 0,
  } },
});
// workerSource exports a WorkerEntrypoint with processEvent(event).
// Its env.ITX.get().append(...) writes derived events. Use stable retry IDs.`,

  `const [commit] = await scope.append({
  id: crypto.randomUUID(), type: "repo.commit",
  data: { name: "config", parent: null, message: "First version",
    files: { "main.js": workerSource } },
});
const head = await scope.invoke(["repos", "head"], "config");
// A later processor setting selects source: { repo: "config", revision: head.revision }.
// An edit does not silently activate code. Remote Git is not implemented.`,

  `// One policy module, installed by an itx.set event at "mount/fetch".
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.origin !== "https://api.github.com") return new Response("Denied", { status: 403 });
  const target = await env.NEXT.to({ kind: "network",
    approval: { approval: "required", expiresInMs: 60000 } });
  return target.fetch(request);
} };
// Internal route: const target = await env.NEXT.to({ kind: "worker", source });
// Then return target.fetch(request), including WebSocket upgrades.
// Normal apps get ITX, not NEXT. Their global fetch re-enters this policy.`,

  `await fetch("/mcp?project=demo", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "iterate", arguments: { method: ["inspect"], args: [] } },
  }),
});
// A stateless MCP transport over the same context interface, not another store.`,
];
