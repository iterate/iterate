import type { HarEntryWithExtensions, HarWebSocketMessage } from "./har-extensions.ts";

export type FormatHarEntryOptions = {
  headers: boolean;
  body: boolean;
  maxBodyLength: number;
  prettyJsonMaxLength: number;
  color: boolean;
  timestamp: boolean;
};

const DEFAULTS: FormatHarEntryOptions = {
  headers: false,
  body: false,
  maxBodyLength: 2000,
  prettyJsonMaxLength: 4000,
  color: false,
  timestamp: true,
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

function c(code: string, text: string, enabled: boolean): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

function statusColor(status: number, enabled: boolean): string {
  const s = String(status);
  if (!enabled) return s;
  if (status >= 500) return c(RED, s, true);
  if (status >= 400) return c(YELLOW, s, true);
  if (status >= 300) return c(YELLOW, s, true);
  if (status >= 200) return c(GREEN, s, true);
  return s;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function extractTimestamp(startedDateTime: string): string {
  return startedDateTime.slice(11, 19);
}

function truncateDisplay(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}... (${formatSize(text.length)})`;
}

function tryPrettyJson(text: string, maxLen: number): string | null {
  if (text.length > maxLen) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    const pretty = JSON.stringify(parsed, null, 2);
    if (pretty.length > maxLen) return null;
    return pretty;
  } catch {
    return null;
  }
}

function isSSE(mimeType: string): boolean {
  return mimeType.startsWith("text/event-stream");
}

function formatSSEBody(text: string, opts: FormatHarEntryOptions): string {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") {
      lines.push("");
      continue;
    }
    if (line.startsWith("data:")) {
      const payload = line.slice(line.charAt(5) === " " ? 6 : 5);
      const pretty = tryPrettyJson(payload, opts.prettyJsonMaxLength);
      if (pretty) {
        const label = c(GREEN, "data:", opts.color);
        const indented = pretty
          .split("\n")
          .map((l, i) => (i === 0 ? l : `      ${l}`))
          .join("\n");
        lines.push(`${label} ${indented}`);
      } else {
        lines.push(`${c(GREEN, "data:", opts.color)} ${payload}`);
      }
    } else if (line.startsWith("event:")) {
      lines.push(
        `${c(CYAN, "event:", opts.color)} ${c(BOLD, line.slice(line.charAt(6) === " " ? 7 : 6), opts.color)}`,
      );
    } else if (line.startsWith("id:")) {
      lines.push(`${c(DIM, "id:", opts.color)} ${line.slice(line.charAt(3) === " " ? 4 : 3)}`);
    } else if (line.startsWith("retry:")) {
      lines.push(`${c(DIM, "retry:", opts.color)} ${line.slice(line.charAt(6) === " " ? 7 : 6)}`);
    } else if (line.startsWith(":")) {
      lines.push(c(DIM, line, opts.color));
    } else {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

function indentBlock(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatHeaders(
  headers: Array<{ name: string; value: string }>,
  sanitizedNames: Set<string>,
  opts: FormatHarEntryOptions,
): string {
  return headers
    .map((h) => {
      const name = c(CYAN, h.name, opts.color);
      const redactedTag = sanitizedNames.has(h.name.toLowerCase())
        ? ` ${c(`${DIM}${RED}`, "[redacted]", opts.color)}`
        : "";
      return `    ${name}: ${h.value}${redactedTag}`;
    })
    .join("\n");
}

function formatWsTimestamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function formatWsMessage(msg: HarWebSocketMessage, opts: FormatHarEntryOptions): string {
  const ts = c(DIM, formatWsTimestamp(msg.time), opts.color);
  const arrow = msg.type === "send" ? c(GREEN, ">>>", opts.color) : c(BLUE, "<<<", opts.color);

  if (msg.opcode === 2) {
    return `    ${ts} ${arrow} ${c(DIM, `[binary ${formatSize(msg.data.length)}]`, opts.color)}`;
  }

  if ((msg as { _truncated?: boolean })._truncated) {
    return `    ${ts} ${arrow} ${truncateDisplay(msg.data, opts.maxBodyLength)} ${c(DIM, "(truncated)", opts.color)}`;
  }

  const pretty = tryPrettyJson(msg.data, opts.prettyJsonMaxLength);
  if (pretty) {
    const paddingLen = `    ${formatWsTimestamp(msg.time)} ${msg.type === "send" ? ">>>" : "<<<"} `
      .length;
    const padding = " ".repeat(paddingLen);
    const indented = pretty
      .split("\n")
      .map((line, i) => (i === 0 ? line : `${padding}${line}`))
      .join("\n");
    return `    ${ts} ${arrow} ${indented}`;
  }

  return `    ${ts} ${arrow} ${truncateDisplay(msg.data, opts.maxBodyLength)}`;
}

function isWebSocket(entry: HarEntryWithExtensions): boolean {
  return entry._resourceType === "websocket";
}

export function formatHarEntryOneLine(
  entry: HarEntryWithExtensions,
  options?: { color?: boolean },
): string {
  const color = options?.color ?? false;
  const method = isWebSocket(entry) ? "WS" : entry.request.method;
  const status = statusColor(entry.response.status, color);
  const duration = formatDuration(entry.time);

  let suffix = "";
  if (isWebSocket(entry) && entry._webSocketMessages) {
    const count = entry._webSocketMessages.length;
    suffix = `, ${String(count)} msg${count !== 1 ? "s" : ""}`;
  }

  return `${c(BOLD, method, color)} ${entry.request.url} -> ${status} (${duration}${suffix})`;
}

export function formatHarEntry(
  entry: HarEntryWithExtensions,
  options?: Partial<FormatHarEntryOptions>,
): string {
  const opts = { ...DEFAULTS, ...options };
  const lines: string[] = [];
  const meta = entry._iterateMetadata;
  const sanitizedHeaders = new Set(meta?.sanitizedHeaders ?? []);

  const prefix = opts.timestamp
    ? `${c(DIM, extractTimestamp(entry.startedDateTime), opts.color)} `
    : "";
  lines.push(`${prefix}${formatHarEntryOneLine(entry, { color: opts.color })}`);

  if (opts.headers) {
    lines.push(c(DIM, "  -- Request headers --", opts.color));
    lines.push(formatHeaders(entry.request.headers, sanitizedHeaders, opts));

    lines.push(c(DIM, "  -- Response headers --", opts.color));
    lines.push(formatHeaders(entry.response.headers, sanitizedHeaders, opts));
  }

  if (opts.body) {
    if (isWebSocket(entry) && entry._webSocketMessages) {
      const msgs = entry._webSocketMessages;
      lines.push(c(DIM, `  -- Messages (${String(msgs.length)}) --`, opts.color));
      for (const msg of msgs) {
        lines.push(formatWsMessage(msg, opts));
      }
    } else {
      if (entry.request.postData?.text) {
        const sizeLabel = formatSize(entry.request.bodySize);
        const truncLabel =
          meta?.requestBodyTruncated && meta.requestBodyOriginalSize
            ? `, truncated from ${formatSize(meta.requestBodyOriginalSize)}`
            : "";
        lines.push(c(DIM, `  -- Request body (${sizeLabel}${truncLabel}) --`, opts.color));

        const pretty = tryPrettyJson(entry.request.postData.text, opts.prettyJsonMaxLength);
        const bodyText = pretty ?? truncateDisplay(entry.request.postData.text, opts.maxBodyLength);
        lines.push(indentBlock(bodyText, "    "));
      }

      if (entry.response.content.text) {
        const sizeLabel = formatSize(entry.response.content.size);
        const truncLabel =
          meta?.responseBodyTruncated && meta.responseBodyOriginalSize
            ? `, truncated from ${formatSize(meta.responseBodyOriginalSize)}`
            : "";
        lines.push(c(DIM, `  -- Response body (${sizeLabel}${truncLabel}) --`, opts.color));

        if (isSSE(entry.response.content.mimeType)) {
          const sseText = truncateDisplay(entry.response.content.text, opts.maxBodyLength);
          lines.push(indentBlock(formatSSEBody(sseText, opts), "    "));
        } else {
          const pretty = tryPrettyJson(entry.response.content.text, opts.prettyJsonMaxLength);
          const bodyText =
            pretty ?? truncateDisplay(entry.response.content.text, opts.maxBodyLength);
          lines.push(indentBlock(bodyText, "    "));
        }
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}
