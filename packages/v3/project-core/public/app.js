import { examples } from "./examples.js";

const $ = (id) => document.getElementById(id);
const state = { events: [], follow: null, keyPair: null };
const lessons = [
  [
    "0 · Lend",
    "A browser owns live capabilities; a hibernating context borrows one only while it needs to call it. This keeps physical sockets out of the durable log.",
    "src/lending.ts",
  ],
  [
    "1 · Address",
    "A project contains independently addressable context paths. <code>/</code>, <code>/agents/review</code>, and <code>/build</code> are separate logs, not folders or UI tabs.",
    "src/model.ts",
  ],
  [
    "2 · Stream",
    "Append is the commit point. Read replays ordered offsets; follow is a WebSocket replay plus tail. Use the console below to exercise these server calls.",
    "src/worker.ts",
  ],
  [
    "3 · Signed events",
    "Claimed provenance is signed data; platform-observed context, offset and time are committed separately. The append gate checks every Ed25519 signature and stamps level 0, 1 or 2 plus its verified signers. A project can progressively lock itself down.",
    "src/signatures.ts",
  ],
  [
    "4 · Workers",
    "A config worker is a normal stream processor. It receives committed events and scoped project access; successful delivery advances its durable cursor. Three failed attempts halt with an inspectable explanation.",
    "src/worker.ts",
  ],
  [
    "5 · Repos + config",
    "A repository revision is an immutable source address. A repo.commit fact creates a snapshot; a separate processor setting selects the pinned config revision. Remote Git mirroring and collaborative workspaces are further layers.",
    "src/repositories.ts",
  ],
  [
    "6 · Fetch + secrets + approval",
    "One fetch gate owns ingress and egress. Secret material only reaches an origin-pinned final request. Held egress is released only by a matching signed approval decision.",
    "src/egress.ts",
  ],
  [
    "7 · UI + MCP",
    "This console and the /mcp transport call the same small interface. Neither gets a backdoor: inspect explains state, append writes facts, and follow observes the stream.",
    "src/mcp.ts",
  ],
];

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}
function signingBytes(context, event) {
  return new TextEncoder().encode(
    canonical({
      context,
      data: event.data,
      domain: "iterate.event.v1",
      id: event.id,
      provenance: {
        parents: event.provenance?.parents || [],
        ...(event.provenance?.producer && { producer: event.provenance.producer }),
      },
      type: event.type,
    }),
  );
}
function base64url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function address() {
  return { project: $("project").value.trim(), path: $("path").value.trim() || "/" };
}
function apiUrl() {
  const { project, path } = address();
  const url = new URL("/api", location.href);
  url.searchParams.set("project", project);
  url.searchParams.set("path", path);
  return url;
}
function setStatus(message, failure = false) {
  $("status").textContent = message;
  $("status").style.color = failure ? "var(--red)" : "var(--muted)";
}
async function call(method, args = []) {
  const response = await fetch(apiUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, args }),
  });
  const body = await response
    .json()
    .catch(() => ({ error: { code: "HTTP", message: response.statusText } }));
  if (!response.ok || body.error)
    throw new Error(
      `${body.error?.code || response.status}: ${body.error?.message || "request failed"}`,
    );
  return body.result;
}
function eventLine(event) {
  const item = document.createElement("li");
  item.innerHTML = "<details><summary></summary><pre></pre></details>";
  item.querySelector("summary").textContent =
    `${event.offset} · ${event.type} · L${event.verification.level}`;
  item.querySelector("pre").textContent = JSON.stringify(event, null, 2);
  return item;
}
function renderEvents() {
  $("events").replaceChildren(...state.events.map(eventLine));
}
function receive(message) {
  const events = message.events || message.result?.events;
  if (!Array.isArray(events)) return;
  const known = new Set(state.events.map((event) => `${event.offset}:${event.id}`));
  state.events.push(...events.filter((event) => !known.has(`${event.offset}:${event.id}`)));
  state.events.sort((a, b) => a.offset - b.offset);
  renderEvents();
}
async function replay() {
  try {
    const result = await call(["readEvents"], [{ afterOffset: 0, limit: 128 }]);
    state.events = result.events || [];
    renderEvents();
    setStatus(`Replayed through offset ${result.throughOffset ?? result.head ?? 0}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}
function stopFollowing() {
  state.follow?.close();
  state.follow = null;
  $("follow").setAttribute("aria-pressed", "false");
  $("follow").textContent = "Follow";
  $("connection").textContent = "not connected";
}
function follow() {
  if (state.follow) return stopFollowing();
  const { project, path } = address();
  const url = new URL("/events", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("project", project);
  url.searchParams.set("path", path);
  url.searchParams.set("afterOffset", String(state.events.at(-1)?.offset || 0));
  const socket = new WebSocket(url);
  state.follow = socket;
  $("follow").setAttribute("aria-pressed", "true");
  $("follow").textContent = "Stop following";
  $("connection").textContent = "connecting";
  socket.onopen = () => {
    $("connection").textContent = "following live";
  };
  socket.onmessage = ({ data }) => {
    try {
      const page = JSON.parse(data);
      receive(page);
      socket.send(JSON.stringify({ afterOffset: page.throughOffset }));
    } catch {
      setStatus("Received malformed event stream message.", true);
      stopFollowing();
    }
  };
  socket.onerror = () => setStatus("Event stream connection failed.", true);
  socket.onclose = () => {
    if (state.follow === socket) stopFollowing();
  };
}
async function append(event) {
  try {
    const result = await call(["append"], [event]);
    receive({ events: Array.isArray(result) ? result : result.events || [result] });
    setStatus("Appended durable event.");
    $("event-id").value = crypto.randomUUID();
  } catch (error) {
    setStatus(error.message, true);
  }
}
async function sign(event) {
  const { context } = await call(["inspect"]);
  state.keyPair ||= await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const key = await crypto.subtle.exportKey("jwk", state.keyPair.publicKey);
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    state.keyPair.privateKey,
    signingBytes(context.name, event),
  );
  return {
    ...event,
    provenance: {
      parents: event.provenance?.parents || [],
      ...(event.provenance?.producer && { producer: event.provenance.producer }),
      signatures: [
        ...(event.provenance?.signatures || []),
        { key, value: base64url(new Uint8Array(signature)) },
      ],
    },
  };
}
function setupTutorial() {
  $("lessons").replaceChildren(
    ...lessons.map(([title, body, source], index) => {
      const lesson = document.createElement("details");
      lesson.name = "lessons";
      lesson.open = index === 0;
      lesson.innerHTML = `<summary>${title}</summary><p>${body}</p><pre><code></code></pre><code>Source in checkout: ${source}</code>`;
      lesson.querySelector("pre code").textContent = examples[index];
      return lesson;
    }),
  );
}

$("project").value = `demo-${crypto.randomUUID().slice(0, 8)}`;
$("event-id").value = crypto.randomUUID();
setupTutorial();
fetch("/session")
  .then((response) => (response.ok ? response.json() : Promise.reject()))
  .then(({ email }) => ($("identity").textContent = `${email} · switch`))
  .catch(() => ($("identity").textContent = "Identity unavailable · switch"));
$("append-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    let input = {
      id: $("event-id").value.trim(),
      type: $("event-type").value.trim(),
      data: JSON.parse($("event-data").value),
    };
    if ($("signed").checked) input = await sign(input);
    await append(input);
  } catch (error) {
    setStatus(error.message, true);
  }
};
$("inspect").onclick = async () => {
  try {
    setStatus(JSON.stringify(await call(["inspect"]), null, 2));
  } catch (error) {
    setStatus(error.message, true);
  }
};
$("replay").onclick = replay;
$("follow").onclick = follow;
for (const field of [$("project"), $("path")])
  field.onchange = () => {
    stopFollowing();
    state.events = [];
    renderEvents();
    setStatus("Context changed; replay or follow its stream.");
  };
