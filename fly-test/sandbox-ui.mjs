#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import querystring from "node:querystring";

const PORT = Number(process.env.SANDBOX_PORT ?? "8080");
const PROXY_URL = process.env.EGRESS_PROXY_URL ?? "";
const LOG_PATH = process.env.SANDBOX_LOG_PATH ?? "/tmp/sandbox-ui.log";
const DEFAULT_TARGET_URL = process.env.DEFAULT_TARGET_URL ?? "http://neverssl.com/";

if (PROXY_URL.length === 0) {
  process.stderr.write("Missing EGRESS_PROXY_URL\n");
  process.exit(1);
}

function nowUtc() {
  return new Date().toISOString();
}

function appendLog(message) {
  const line = `${nowUtc()} ${message}`;
  process.stdout.write(`${line}\n`);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

function escapeHtml(input) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage(url, result) {
  const safeUrl = escapeHtml(url);
  const safeProxy = escapeHtml(PROXY_URL);
  const safeResult = escapeHtml(result);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sandbox Outbound Test</title>
  <style>
    body { margin: 24px; background: #f8fafc; color: #0f172a; font-family: ui-sans-serif, -apple-system, Segoe UI, sans-serif; }
    .card { max-width: 920px; background: #fff; border: 1px solid #cbd5e1; border-radius: 12px; padding: 16px; }
    .muted { color: #475569; font-size: 13px; }
    input { width: 100%; padding: 10px; font-size: 14px; border: 1px solid #94a3b8; border-radius: 8px; margin-top: 6px; }
    button { margin-top: 12px; padding: 10px 14px; border: 0; border-radius: 8px; background: #0f172a; color: #fff; cursor: pointer; }
    pre { white-space: pre-wrap; word-wrap: break-word; background: #020617; color: #e2e8f0; border-radius: 8px; min-height: 180px; padding: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Sandbox Outbound Fetch</h2>
    <p class="muted">Outbound requests are sent through proxy: <code>${safeProxy}</code></p>
    <form method="post" action="/fetch">
      <label for="url">Target URL</label>
      <input id="url" name="url" type="url" required value="${safeUrl}" />
      <button type="submit">Fetch Through Proxy</button>
    </form>
    <h3>Result</h3>
    <pre>${safeResult}</pre>
  </div>
</body>
</html>`;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function fetchViaProxy(url) {
  return new Promise((resolve, reject) => {
    const args = [
      "-sS",
      "-L",
      "--max-time",
      "25",
      "-x",
      PROXY_URL,
      "-w",
      "\n__STATUS__:%{http_code}\n",
      url,
    ];
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(`curl exit=${code} stderr=${err.trim()}`));
        return;
      }
      const marker = "\n__STATUS__:";
      const idx = out.lastIndexOf(marker);
      if (idx < 0) {
        resolve({ status: "unknown", body: out, stderr: err });
        return;
      }
      const body = out.slice(0, idx);
      const status = out.slice(idx + marker.length).trim();
      resolve({ status, body, stderr: err });
    });
  });
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("bad request");
    return;
  }
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
    return;
  }

  if (req.method === "GET") {
    sendHtml(res, renderPage(DEFAULT_TARGET_URL, "Submit form to trigger outbound fetch."));
    return;
  }

  if (req.method === "POST" && req.url === "/fetch") {
    const rawBody = await readRequestBody(req);
    const form = querystring.parse(rawBody);
    const target = String(form.url ?? "").trim();
    if (target.length === 0) {
      sendHtml(res, renderPage(DEFAULT_TARGET_URL, "error: missing url"));
      return;
    }

    appendLog(`FETCH_START url="${target}" proxy="${PROXY_URL}"`);
    try {
      const result = await fetchViaProxy(target);
      appendLog(`FETCH_OK url="${target}" status=${result.status}`);
      const output = `ok\nstatus=${result.status}\n\n${result.body.slice(0, 2500)}`;
      sendHtml(res, renderPage(target, output));
    } catch (error) {
      appendLog(`FETCH_ERROR url="${target}" err="${error.message}"`);
      sendHtml(res, renderPage(target, `error\n${error.message}`));
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

fs.mkdirSync("/tmp", { recursive: true });
fs.appendFileSync(LOG_PATH, "");
appendLog(`BOOT pid=${process.pid} port=${PORT} proxy="${PROXY_URL}"`);

server.listen(PORT, "0.0.0.0", () => {
  appendLog(`LISTEN port=${PORT}`);
});
