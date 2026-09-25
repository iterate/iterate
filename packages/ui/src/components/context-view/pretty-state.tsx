// The Pretty half of the processors panel's Pretty / Raw toggle: a state read as fields instead of
// YAML. `PrettyFields` reads ANY state (a hosted processor's is the app's own shape): its top-level
// fields one line each, a nested object one level in, a long list folded behind its count.
// `CorePrettyState` reads the core reduce (apps/os `CoreState`): where the context is, its rewrite
// rules, schedules, fetch routes and open script runs, the pause. Every read is defensive: the state
// crosses the wire untyped, and a shape miss degrades to the generic fields, never a crash.
import type { ReactNode } from "react";
import { isRecord, record } from "./renderer-helpers.tsx";

/** A state as fields, one line each. */
export function PrettyFields({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (!isRecord(value)) return <PrettyScalar value={value} />;
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="text-xs text-muted-foreground">empty</span>;
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
      {entries.map(([key, field]) => (
        <PrettyField key={key} label={key} value={field} depth={depth} />
      ))}
    </dl>
  );
}

function PrettyField({ label, value, depth }: { label: string; value: unknown; depth: number }) {
  return (
    <>
      <dt className="truncate font-mono text-muted-foreground" title={label}>
        {label}
      </dt>
      <dd className="min-w-0">
        <PrettyFieldValue value={value} depth={depth} />
      </dd>
    </>
  );
}

function PrettyFieldValue({ value, depth }: { value: unknown; depth: number }): ReactNode {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">none</span>;
    if (value.length <= 8 && value.every((item) => !isRecord(item) && !Array.isArray(item)))
      return <span className="font-mono break-all">{value.map(scalarText).join(", ")}</span>;
    if (depth > 0 && compactJson(value, 200).length <= 100)
      return <span className="font-mono break-all">{compactJson(value, 100)}</span>;
    return (
      <Folded summary={`${value.length.toLocaleString()} ${value.length === 1 ? "item" : "items"}`}>
        <CompactLines items={value.map((item, index) => [`${index}`, item])} />
      </Folded>
    );
  }
  if (isRecord(value)) {
    const size = Object.keys(value).length;
    if (size === 0) return <span className="text-muted-foreground">{"{}"}</span>;
    if (depth === 0) return <PrettyFields value={value} depth={1} />;
    if (compactJson(value, 200).length <= 100)
      return <span className="font-mono break-all">{compactJson(value, 100)}</span>;
    return (
      <Folded summary={`${size.toLocaleString()} ${size === 1 ? "field" : "fields"}`}>
        <CompactLines items={Object.entries(value)} />
      </Folded>
    );
  }
  return <PrettyScalar value={value} />;
}

function PrettyScalar({ value }: { value: unknown }) {
  if (value == null) return <span className="text-xs text-muted-foreground">—</span>;
  const text = scalarText(value);
  return (
    <span className="font-mono text-xs break-all" title={text.length > 200 ? text : undefined}>
      {text.length > 200 ? `${text.slice(0, 199)}…` : text}
    </span>
  );
}

/** A list folded behind its count: opened in place, each entry one compact line. */
function Folded({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details>
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        {summary}
      </summary>
      {children}
    </details>
  );
}

/** Up to 50 entries, each `key  {compact json}` on one line; the rest counted. */
function CompactLines({ items }: { items: [string, unknown][] }) {
  return (
    <div className="flex flex-col py-0.5">
      {items.slice(0, 50).map(([key, item]) => (
        <p key={key} className="truncate font-mono" title={compactJson(item, 2000)}>
          <span className="text-muted-foreground">{key}</span> {compactJson(item, 240)}
        </p>
      ))}
      {items.length > 50 ? (
        <p className="text-muted-foreground">+{(items.length - 50).toLocaleString()} more</p>
      ) : null}
    </div>
  );
}

/** The core reduce, read: where the context is, the pause, and each of its tables. The
 *  subscriptions table is the panel's subscriber list, so it is only counted here. */
export function CorePrettyState({ state }: { state: unknown }) {
  if (!isRecord(state) || !("subscriptions" in state)) return <PrettyFields value={state} />;
  const rules = Object.entries(record(state.itxExpressionRewriteRules));
  const schedules = Object.entries(record(state.schedules));
  const routes = Object.entries(record(state.fetchRoutes));
  const runs = Object.entries(record(state.scriptRuns));
  const tables: [string, unknown[]][] = [
    ["rewrite rules", rules],
    ["schedules", schedules],
    ["fetch routes", routes],
    ["open script runs", runs],
  ];
  const empty = tables.filter(([, table]) => table.length === 0).map(([name]) => name);
  const paused = isRecord(state.paused) ? { reason: scalarText(state.paused.reason) } : undefined;
  const facts: [string, unknown][] = [
    ["path", state.path],
    ["project", state.projectId],
    ["created", state.createdAt],
    ["incarnation", state.incarnation],
    ["ingress", state.ingressTarget ? printExpression(state.ingressTarget) : undefined],
  ];
  return (
    <div className="flex flex-col gap-3 text-xs">
      {paused ? (
        <p className="text-amber-700">Paused{paused.reason ? `: ${paused.reason}` : ""}</p>
      ) : null}
      <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        {facts
          .filter(([, value]) => value != null)
          .map(([label, value]) => (
            <PrettyField key={label} label={label} value={value} depth={1} />
          ))}
        <PrettyField
          label="subscriptions"
          value={`${Object.keys(record(state.subscriptions)).length} (listed above)`}
          depth={1}
        />
      </dl>
      {rules.length > 0 ? (
        <CoreTable title="Rewrite rules" count={rules.length}>
          {rules.map(([match, rule]) => {
            const row = record(rule);
            return (
              <p key={match} className="font-mono break-all">
                {match} <span className="text-muted-foreground">→</span>{" "}
                {row.target === null ? "denied" : printExpression(row.target)}
                {typeof row.description === "string" ? (
                  <span className="ml-2 font-sans text-muted-foreground">{row.description}</span>
                ) : null}
              </p>
            );
          })}
        </CoreTable>
      ) : null}
      {schedules.length > 0 ? (
        <CoreTable title="Schedules" count={schedules.length}>
          <CompactLines items={schedules} />
        </CoreTable>
      ) : null}
      {routes.length > 0 ? (
        <CoreTable title="Fetch routes" count={routes.length}>
          <CompactLines items={routes} />
        </CoreTable>
      ) : null}
      {runs.length > 0 ? (
        <CoreTable title="Open script runs" count={runs.length}>
          {runs.map(([offset, run]) => (
            <p key={offset} className="font-mono">
              #{offset}{" "}
              <span className="text-muted-foreground">
                requested {scalarText(record(run).requestedAt)}
              </span>
            </p>
          ))}
        </CoreTable>
      ) : null}
      {empty.length > 0 ? <p className="text-muted-foreground">No {empty.join(", ")}.</p> : null}
    </div>
  );
}

function CoreTable({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-muted-foreground">
        {title} <span className="tabular-nums">{count}</span>
      </p>
      {children}
    </div>
  );
}

/** A parsed itx expression as the call it spells: `["itx","builtins",["get","x"],"run"]` →
 *  `itx.builtins.get("x").run`. Anything else, as compact JSON. */
export function printExpression(expression: unknown): string {
  if (typeof expression === "string") return expression;
  if (!Array.isArray(expression)) return compactJson(expression, 240);
  const steps: string[] = [];
  for (const step of expression) {
    if (typeof step === "string") steps.push(step);
    else if (Array.isArray(step) && typeof step[0] === "string")
      steps.push(
        `${step[0]}(${step
          .slice(1)
          .map((arg) => compactJson(arg, 80))
          .join(", ")})`,
      );
    else return compactJson(expression, 240);
  }
  return steps.join(".");
}

function scalarText(value: unknown): string {
  return typeof value === "string" ? value : compactJson(value, 400);
}

function compactJson(value: unknown, max: number): string {
  let text: string;
  try {
    text = JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    );
  } catch {
    text = String(value);
  }
  text ||= String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
