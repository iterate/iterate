import { Schedrruler } from "./schedrruler";

export type DurableObjectId = { toString(): string };

export interface DurableObjectStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  newUniqueId(): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export type Env = {
  SCHEDRRULER: DurableObjectNamespace;
};

export { Schedrruler };

const HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Schedrruler playground</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light dark;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background-color: #f6f8fa;
      }

      body {
        margin: 0 auto;
        padding: 2rem 1.5rem 4rem;
        max-width: 1040px;
        color: inherit;
        background: transparent;
      }

      h1 {
        margin-top: 0;
        font-size: clamp(2rem, 3vw, 2.5rem);
      }

      main {
        display: grid;
        gap: 2rem;
      }

      section {
        background: rgba(255, 255, 255, 0.85);
        border-radius: 1rem;
        padding: 1.5rem;
        box-shadow: 0 1rem 2.5rem rgba(15, 23, 42, 0.08);
        backdrop-filter: blur(6px);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          background-color: #0b1220;
        }

        section {
          background: rgba(17, 24, 39, 0.8);
          box-shadow: 0 1rem 2rem rgba(0, 0, 0, 0.4);
        }
      }

      form {
        display: grid;
        gap: 1rem;
      }

      label {
        display: grid;
        gap: 0.35rem;
        font-weight: 600;
      }

      input[type="text"],
      select,
      textarea {
        font: inherit;
        padding: 0.6rem 0.75rem;
        border-radius: 0.65rem;
        border: 1px solid rgba(15, 23, 42, 0.15);
        background: rgba(255, 255, 255, 0.9);
        color: inherit;
      }

      textarea {
        min-height: 7rem;
        resize: vertical;
        line-height: 1.4;
      }

      button {
        font: inherit;
        border: none;
        border-radius: 9999px;
        padding: 0.55rem 1.25rem;
        background: linear-gradient(135deg, #2563eb, #7c3aed);
        color: white;
        cursor: pointer;
        transition: transform 150ms ease, box-shadow 150ms ease, filter 150ms ease;
      }

      button:hover {
        transform: translateY(-1px);
        box-shadow: 0 0.75rem 1.5rem rgba(37, 99, 235, 0.35);
        filter: brightness(1.05);
      }

      button[disabled] {
        cursor: not-allowed;
        opacity: 0.6;
        box-shadow: none;
        transform: none;
      }

      .muted-button {
        background: rgba(15, 23, 42, 0.08);
        color: inherit;
      }

      .muted-button:hover {
        box-shadow: none;
        filter: none;
        transform: translateY(-1px);
      }

      .status {
        min-height: 1.25rem;
        font-size: 0.95rem;
        color: #2563eb;
      }

      .status.error {
        color: #ef4444;
      }

      .examples {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        padding-left: 0;
        margin: 0;
        list-style: none;
      }

      .examples li {
        margin: 0;
      }

      .examples button {
        background: rgba(37, 99, 235, 0.12);
        color: inherit;
      }

      .rules-grid {
        display: grid;
        gap: 1rem;
      }

      .rule-card,
      .event-card {
        border-radius: 1rem;
        padding: 1rem 1.25rem;
        background: rgba(15, 23, 42, 0.04);
        display: grid;
        gap: 0.6rem;
      }

      .rule-header,
      .event-header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 0.75rem;
      }

      .rule-actions {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
      }

      code,
      pre {
        font-family: "JetBrains Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        background: rgba(15, 23, 42, 0.05);
        padding: 0.35rem 0.5rem;
        border-radius: 0.6rem;
        font-size: 0.85rem;
        overflow-x: auto;
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .detail-row {
        display: grid;
        grid-template-columns: minmax(110px, auto) 1fr;
        gap: 0.5rem;
        align-items: start;
        font-size: 0.95rem;
      }

      .detail-label {
        font-weight: 600;
        opacity: 0.75;
      }

      .event-summary {
        font-size: 0.95rem;
        opacity: 0.8;
      }

      .empty-state {
        margin: 0;
        padding: 1rem;
        text-align: center;
        border-radius: 0.75rem;
        background: rgba(15, 23, 42, 0.05);
      }
    </style>
  </head>
  <body>
    <h1>Schedrruler playground</h1>
    <p>Interact with the Durable Object scheduler: add directives, invoke them manually, and inspect the event log in real time.</p>
    <main>
      <section>
        <h2>Create or update a directive</h2>
        <form id="directive-form">
          <label>
            Directive key
            <input name="key" type="text" placeholder="my-directive" required />
          </label>
          <label>
            Instruction type
            <select name="instruction-kind">
              <option value="rrule">RRULE</option>
              <option value="cron">Cron</option>
              <option value="once">Once</option>
            </select>
          </label>
          <label id="instruction-value-label">
            <span>Instruction value</span>
            <input name="instruction-value" type="text" placeholder="FREQ=MINUTELY;INTERVAL=1" required />
          </label>
          <label>
            Method
            <select name="method">
              <option value="log">log</option>
              <option value="error">error</option>
            </select>
          </label>
          <label>
            Args (JSON, optional)
            <textarea name="args" placeholder='{ "message": "Hello" }'></textarea>
          </label>
          <div class="rule-actions">
            <button type="submit">Save directive</button>
            <button type="button" class="muted-button" id="clear-form">Clear</button>
          </div>
          <div class="status" id="directive-status" role="status" aria-live="polite"></div>
        </form>
      </section>

      <section>
        <h2>Example directives</h2>
        <p>Select an example to populate the form. Each example generates a unique key.</p>
        <ul class="examples" id="example-directives"></ul>
      </section>

      <section>
        <h2>Active directives</h2>
        <div class="rules-grid" id="directives-list">
          <p class="empty-state">Loading directives…</p>
        </div>
      </section>

      <section>
        <h2>Event log</h2>
        <div class="rules-grid" id="event-log">
          <p class="empty-state">Waiting for events…</p>
        </div>
      </section>
    </main>

    <script type="module">
      const form = document.getElementById("directive-form");
      const keyInput = form.querySelector('[name="key"]');
      const instructionKind = form.querySelector('[name="instruction-kind"]');
      const instructionValue = form.querySelector('[name="instruction-value"]');
      const instructionValueLabel = document.querySelector('#instruction-value-label span');
      const methodInput = form.querySelector('[name="method"]');
      const argsInput = form.querySelector('[name="args"]');
      const status = document.getElementById("directive-status");
      const examplesList = document.getElementById("example-directives");
      const directivesList = document.getElementById("directives-list");
      const eventLog = document.getElementById("event-log");
      const clearButton = document.getElementById("clear-form");

      const EXAMPLES = [
        {
          label: "Invoke once in ~3 seconds",
          prepare() {
            const at = new Date(Date.now() + 3000).toISOString();
            return {
              key: 'once-' + Math.random().toString(36).slice(2, 8),
              instruction: { kind: "once", at },
              method: "log",
              args: {
                message: "Triggers roughly three seconds after creation",
                createdAt: at,
              },
            };
          },
        },
        {
          label: "RRULE: every minute",
          prepare() {
            return {
              key: 'rrule-' + Math.random().toString(36).slice(2, 8),
              instruction: { kind: "rrule", rrule: "FREQ=MINUTELY;INTERVAL=1" },
              method: "log",
              args: { message: "Runs once per minute" },
            };
          },
        },
        {
          label: "Cron: every 10 seconds",
          prepare() {
            return {
              key: 'cron-' + Math.random().toString(36).slice(2, 8),
              instruction: { kind: "cron", cron: "*/10 * * * * *" },
              method: "log",
            };
          },
        },
      ];

      function renderExamples() {
        examplesList.innerHTML = "";
        EXAMPLES.forEach((example) => {
          const li = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = example.label;
          button.classList.add("muted-button");
          button.addEventListener("click", () => {
            const payload = example.prepare();
            keyInput.value = payload.key;
            if (payload.instruction) {
              instructionKind.value = payload.instruction.kind;
              updateInstructionLabel();
              if (payload.instruction.kind === "rrule") {
                instructionValue.value = payload.instruction.rrule;
              } else if (payload.instruction.kind === "cron") {
                instructionValue.value = payload.instruction.cron;
              } else {
                instructionValue.value = String(payload.instruction.at);
              }
            }
            methodInput.value = payload.method;
            argsInput.value = payload.args ? JSON.stringify(payload.args, null, 2) : "";
            status.classList.remove("error");
            status.textContent = "Example loaded into the form.";
          });
          li.appendChild(button);
          examplesList.appendChild(li);
        });
      }

      renderExamples();

      function updateInstructionLabel() {
        const kind = instructionKind.value;
        const placeholderMap = {
          rrule: "FREQ=MINUTELY;INTERVAL=1",
          cron: "*/5 * * * * *",
          once: new Date(Date.now() + 60_000).toISOString(),
        };
        const labelText =
          kind === "cron"
            ? "Cron expression"
            : kind === "once"
              ? "Run at (ISO string or timestamp)"
              : "RRULE string";
        if (instructionValueLabel) {
          instructionValueLabel.textContent = labelText;
        }
        instructionValue.placeholder = placeholderMap[kind] || "";
        if (kind === "once" && !instructionValue.value) {
          instructionValue.value = new Date(Date.now() + 60_000).toISOString();
        }
      }

      instructionKind.addEventListener("change", updateInstructionLabel);
      updateInstructionLabel();

      function formatError(error) {
        if (error && typeof error === "object" && "message" in error) {
          return String(error.message);
        }
        return String(error);
      }

      function resolveOnceValue(value) {
        const trimmed = value.trim();
        if (!trimmed) return null;
        if (/^\d+$/.test(trimmed)) {
          return Number(trimmed);
        }
        const relativeMatch = trimmed.match(/^\+(\d+)([smhd])$/i);
        if (relativeMatch) {
          const amount = Number(relativeMatch[1]);
          const unit = relativeMatch[2].toLowerCase();
          const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
          const delta = amount * (multipliers[unit] ?? 0);
          return new Date(Date.now() + delta).toISOString();
        }
        return trimmed;
      }

      function buildInstruction(kind, rawValue) {
        const value = rawValue.trim();
        if (!value) {
          return null;
        }
        switch (kind) {
          case "rrule":
            return { kind: "rrule", rrule: value };
          case "cron":
            return { kind: "cron", cron: value };
          case "once": {
            const resolved = resolveOnceValue(value);
            if (resolved == null) return null;
            return { kind: "once", at: resolved };
          }
          default:
            return null;
        }
      }

      async function postEvent(payload) {
        const response = await fetch("/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error('Request failed with status ' + response.status);
        }
        return response;
      }

      async function handleEventSubmission(payload, successMessage) {
        try {
          status.classList.remove("error");
          status.textContent = "Sending…";
          await postEvent(payload);
          status.textContent = successMessage;
          await refresh();
        } catch (error) {
          status.classList.add("error");
          status.textContent = formatError(error);
        }
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const key = keyInput.value.trim();
        const method = methodInput.value.trim();
        const argsText = argsInput.value.trim();
        const instruction = buildInstruction(instructionKind.value, instructionValue.value);

        if (!key || !method || !instruction) {
          status.classList.add("error");
          status.textContent = "Key, instruction, and method are required.";
          return;
        }

        let args;
        if (argsText) {
          try {
            args = JSON.parse(argsText);
          } catch (error) {
            status.classList.add("error");
            status.textContent = 'Invalid JSON: ' + formatError(error);
            return;
          }
        }

        const payload = {
          type: "directive_add",
          key,
          instruction,
          method,
        };

        if (args !== undefined) {
          payload.args = args;
        }

        await handleEventSubmission(payload, "Directive saved.");
      });

      clearButton.addEventListener("click", () => {
        form.reset();
        argsInput.value = "";
        status.classList.remove("error");
        status.textContent = "Form cleared.";
        updateInstructionLabel();
      });

      function formatRelativeTime(iso) {
        if (!iso) {
          return "—";
        }
        const target = new Date(iso);
        if (Number.isNaN(target.getTime())) {
          return "—";
        }
        const diff = target.getTime() - Date.now();
        const seconds = Math.round(diff / 1000);
        if (seconds === 0) {
          return "now";
        }
        const suffix = seconds > 0 ? "from now" : "ago";
        return Math.abs(seconds) + "s " + suffix;
      }

      function formatJson(value, hasValue) {
        if (!hasValue) {
          return "undefined";
        }
        try {
          return JSON.stringify(value, null, 2);
        } catch (error) {
          return formatError(error);
        }
      }

      function formatTimestamp(input) {
        if (typeof input === "number") {
          return new Date(input).toISOString();
        }
        return String(input);
      }

      function formatInstruction(instruction) {
        if (!instruction || typeof instruction !== "object") {
          return "Unknown instruction";
        }
        switch (instruction.kind) {
          case "rrule":
            return 'RRULE ' + instruction.rrule;
          case "cron": {
            const tz = instruction.timezone ? ' (tz ' + instruction.timezone + ')' : '';
            return 'Cron ' + instruction.cron + tz;
          }
          case "once":
            return 'Once @ ' + formatTimestamp(instruction.at);
          default:
            return JSON.stringify(instruction);
        }
      }

      function hasOwn(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
      }

      async function invokeDirective(key) {
        await handleEventSubmission({ type: "invoke", key, mode: "manual" }, 'Invoked ' + key + '.');
      }

      async function deleteDirective(key) {
        await handleEventSubmission({ type: "directive_delete", key }, 'Deleted ' + key + '.');
      }

      function renderDirectives(state) {
        if (!state || !Array.isArray(state.directives) || state.directives.length === 0) {
          directivesList.innerHTML = '';
          const empty = document.createElement("p");
          empty.className = "empty-state";
          empty.textContent = "No active directives. Create one above to get started.";
          directivesList.appendChild(empty);
          return;
        }

        directivesList.innerHTML = "";
        state.directives.forEach((directive) => {
          const card = document.createElement("article");
          card.className = "rule-card";

          const header = document.createElement("div");
          header.className = "rule-header";

          const title = document.createElement("h3");
          title.textContent = directive.key;
          header.appendChild(title);

          const next = document.createElement("span");
          next.className = "event-summary";
          next.textContent = directive.next
            ? new Date(directive.next).toLocaleTimeString() + ' (' + formatRelativeTime(directive.next) + ')'
            : "No future run";
          header.appendChild(next);

          card.appendChild(header);

          const ruleInfo = document.createElement("div");
          ruleInfo.className = "detail-row";
          const label = document.createElement("span");
          label.className = "detail-label";
          label.textContent = "Method";
          const value = document.createElement("span");
          value.textContent = directive.method;
          ruleInfo.appendChild(label);
          ruleInfo.appendChild(value);
          card.appendChild(ruleInfo);

          const instructionRow = document.createElement("div");
          instructionRow.className = "detail-row";
          const instructionLabel = document.createElement("span");
          instructionLabel.className = "detail-label";
          instructionLabel.textContent = "Instruction";
          const instructionValueNode = document.createElement("code");
          instructionValueNode.textContent = formatInstruction(directive.instruction);
          instructionRow.appendChild(instructionLabel);
          instructionRow.appendChild(instructionValueNode);
          card.appendChild(instructionRow);

          const argsRow = document.createElement("div");
          argsRow.className = "detail-row";
          const argsLabel = document.createElement("span");
          argsLabel.className = "detail-label";
          argsLabel.textContent = "Args";
          const argsValue = document.createElement("pre");
          argsValue.textContent = formatJson(directive.args, directive.args !== null && directive.args !== undefined);
          argsRow.appendChild(argsLabel);
          argsRow.appendChild(argsValue);
          card.appendChild(argsRow);

          if (directive.meta !== null && directive.meta !== undefined) {
            const metaRow = document.createElement("div");
            metaRow.className = "detail-row";
            const metaLabel = document.createElement("span");
            metaLabel.className = "detail-label";
            metaLabel.textContent = "Meta";
            const metaValue = document.createElement("pre");
            metaValue.textContent = formatJson(directive.meta, true);
            metaRow.appendChild(metaLabel);
            metaRow.appendChild(metaValue);
            card.appendChild(metaRow);
          }

          const actions = document.createElement("div");
          actions.className = "rule-actions";

          const invokeButton = document.createElement("button");
          invokeButton.type = "button";
          invokeButton.textContent = "Invoke now";
          invokeButton.addEventListener("click", () => {
            invokeDirective(directive.key);
          });
          actions.appendChild(invokeButton);

          const deleteButton = document.createElement("button");
          deleteButton.type = "button";
          deleteButton.textContent = "Delete";
          deleteButton.classList.add("muted-button");
          deleteButton.addEventListener("click", () => {
            deleteDirective(directive.key);
          });
          actions.appendChild(deleteButton);

          card.appendChild(actions);
          directivesList.appendChild(card);
        });
      }

      function renderEvents(rows) {
        if (!Array.isArray(rows) || rows.length === 0) {
          eventLog.innerHTML = '';
          const empty = document.createElement("p");
          empty.className = "empty-state";
          empty.textContent = "No events recorded yet.";
          eventLog.appendChild(empty);
          return;
        }

        eventLog.innerHTML = "";
        rows.forEach((row) => {
          let payload;
          try {
            payload = JSON.parse(row.payload);
          } catch (error) {
            payload = { type: "raw", value: row.payload, parseError: formatError(error) };
          }

          const card = document.createElement("article");
          card.className = "event-card";

          const header = document.createElement("div");
          header.className = "event-header";
          const title = document.createElement("strong");
          const eventKey = payload.key != null ? payload.key : row.rule_key;
          title.textContent = (payload.type ?? row.type) + ' · ' + (eventKey ?? 'unknown');
          header.appendChild(title);
          const timestamp = document.createElement("span");
          timestamp.className = "event-summary";
          timestamp.textContent = new Date(row.ts).toLocaleTimeString();
          header.appendChild(timestamp);
          card.appendChild(header);

          if (payload.type === "invoke") {
            const result = payload.result || {};
            const statusLine = document.createElement("div");
            statusLine.className = "event-summary";
            const statusText = result.ok === false ? "failed" : result.ok ? "succeeded" : "queued";
            statusLine.textContent = (payload.mode ?? "manual") + ' invocation ' + statusText;
            card.appendChild(statusLine);

            const details = document.createElement("div");
            details.className = "rules-grid";

            const methodRow = document.createElement("div");
            methodRow.className = "detail-row";
            const methodLabel = document.createElement("span");
            methodLabel.className = "detail-label";
            methodLabel.textContent = "Method";
            const methodValue = document.createElement("span");
            methodValue.textContent = result.method ?? payload.method ?? "unknown";
            methodRow.appendChild(methodLabel);
            methodRow.appendChild(methodValue);
            details.appendChild(methodRow);

            const argsRow = document.createElement("div");
            argsRow.className = "detail-row";
            const argsLabel = document.createElement("span");
            argsLabel.className = "detail-label";
            argsLabel.textContent = "Args";
            const argsValue = document.createElement("pre");
            const argsPresent = (result && hasOwn(result, "args")) || payload.args !== undefined;
            const argsContent = result && hasOwn(result, "args") ? result.args : payload.args;
            argsValue.textContent = formatJson(argsContent, argsPresent);
            argsRow.appendChild(argsLabel);
            argsRow.appendChild(argsValue);
            details.appendChild(argsRow);

            const valueRow = document.createElement("div");
            valueRow.className = "detail-row";
            const valueLabel = document.createElement("span");
            valueLabel.className = "detail-label";
            valueLabel.textContent = "Return value";
            const valueNode = document.createElement("pre");
            const valuePresent = result && hasOwn(result, "value");
            valueNode.textContent = formatJson(valuePresent ? result.value : undefined, valuePresent);
            valueRow.appendChild(valueLabel);
            valueRow.appendChild(valueNode);
            details.appendChild(valueRow);

            const durationRow = document.createElement("div");
            durationRow.className = "detail-row";
            const durationLabel = document.createElement("span");
            durationLabel.className = "detail-label";
            durationLabel.textContent = "Duration";
            const durationValue = document.createElement("span");
            durationValue.textContent = result.dur != null ? String(result.dur) + 'ms' : "—";
            durationRow.appendChild(durationLabel);
            durationRow.appendChild(durationValue);
            details.appendChild(durationRow);

            if (result.error) {
              const errorRow = document.createElement("div");
              errorRow.className = "detail-row";
              const errorLabel = document.createElement("span");
              errorLabel.className = "detail-label";
              errorLabel.textContent = "Error";
              const errorValue = document.createElement("pre");
              errorValue.textContent = String(result.error);
              errorRow.appendChild(errorLabel);
              errorRow.appendChild(errorValue);
              details.appendChild(errorRow);
            }

            card.appendChild(details);
          } else if (payload.type === "directive_add" || payload.type === "directive_change") {
            const details = document.createElement("div");
            details.className = "rules-grid";

            const instructionRow = document.createElement("div");
            instructionRow.className = "detail-row";
            const instructionLabel = document.createElement("span");
            instructionLabel.className = "detail-label";
            instructionLabel.textContent = "Instruction";
            const instructionValueNode = document.createElement("pre");
            instructionValueNode.textContent = formatInstruction(payload.instruction);
            instructionRow.appendChild(instructionLabel);
            instructionRow.appendChild(instructionValueNode);
            details.appendChild(instructionRow);

            const methodRow = document.createElement("div");
            methodRow.className = "detail-row";
            const methodLabel = document.createElement("span");
            methodLabel.className = "detail-label";
            methodLabel.textContent = "Method";
            const methodValue = document.createElement("span");
            methodValue.textContent = payload.method;
            methodRow.appendChild(methodLabel);
            methodRow.appendChild(methodValue);
            details.appendChild(methodRow);

            const argsRow = document.createElement("div");
            argsRow.className = "detail-row";
            const argsLabel = document.createElement("span");
            argsLabel.className = "detail-label";
            argsLabel.textContent = "Args";
            const argsValue = document.createElement("pre");
            argsValue.textContent = formatJson(payload.args, payload.args !== undefined && payload.args !== null);
            argsRow.appendChild(argsLabel);
            argsRow.appendChild(argsValue);
            details.appendChild(argsRow);

            if (payload.meta !== undefined) {
              const metaRow = document.createElement("div");
              metaRow.className = "detail-row";
              const metaLabel = document.createElement("span");
              metaLabel.className = "detail-label";
              metaLabel.textContent = "Meta";
              const metaValue = document.createElement("pre");
              metaValue.textContent = formatJson(payload.meta, true);
              metaRow.appendChild(metaLabel);
              metaRow.appendChild(metaValue);
              details.appendChild(metaRow);
            }

            card.appendChild(details);
          } else if (payload.type === "directive_delete") {
            const summary = document.createElement("div");
            summary.className = "event-summary";
            summary.textContent = "Directive deleted";
            card.appendChild(summary);
            if (payload.meta !== undefined) {
              const metaRow = document.createElement("div");
              metaRow.className = "detail-row";
              const metaLabel = document.createElement("span");
              metaLabel.className = "detail-label";
              metaLabel.textContent = "Meta";
              const metaValue = document.createElement("pre");
              metaValue.textContent = formatJson(payload.meta, true);
              metaRow.appendChild(metaLabel);
              metaRow.appendChild(metaValue);
              card.appendChild(metaRow);
            }
          } else {
            const payloadBlock = document.createElement("pre");
            payloadBlock.textContent = formatJson(payload, true);
            card.appendChild(payloadBlock);
          }

          eventLog.appendChild(card);
        });
      }

      let refreshInFlight = false;

      async function refresh() {
        if (refreshInFlight) {
          return;
        }
        refreshInFlight = true;
        try {
          const [stateResponse, eventsResponse] = await Promise.all([
            fetch("/api/state"),
            fetch("/events?limit=50"),
          ]);
          const state = await stateResponse.json();
          const events = await eventsResponse.json();
          renderDirectives(state);
          renderEvents(events);
        } catch (error) {
          status.classList.add("error");
          status.textContent = 'Refresh failed: ' + formatError(error);
        } finally {
          refreshInFlight = false;
        }
      }

      refresh();
      setInterval(() => {
        refresh().catch((error) => {
          console.error("Refresh loop error", error);
        });
      }, 1000);
    </script>
  </body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
      return new Response(HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const id = env.SCHEDRRULER.idFromName("singleton");
    const stub = env.SCHEDRRULER.get(id);

    if (request.method === "GET" && url.pathname === "/api/state") {
      const forward = new Request(new URL("/", request.url), request);
      return stub.fetch(forward);
    }

    return stub.fetch(request);
  },
};
