import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/card.tsx";
import { cn } from "./lib/utils.ts";

export function AppShell(props: { children: ReactNode; className?: string }) {
  return (
    <main className={cn("mx-auto w-full max-w-7xl p-4 md:p-6", props.className)}>
      {props.children}
    </main>
  );
}

export function TwoColumnLayout(props: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
      {props.main}
      {props.side}
    </div>
  );
}

export function Panel(props: { children: ReactNode; className?: string }) {
  return (
    <Card className={cn("overflow-hidden", props.className)}>
      <CardContent className="space-y-5 p-5">{props.children}</CardContent>
    </Card>
  );
}

export function PanelHeader(props: { title: string; actions?: ReactNode; subtitle?: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h1 className="text-base font-semibold tracking-tight md:text-lg">{props.title}</h1>
        {props.subtitle ? <p className="text-sm text-muted-foreground">{props.subtitle}</p> : null}
      </div>
      {props.actions ? <div className="shrink-0">{props.actions}</div> : null}
    </div>
  );
}

export function ApiLinksCard(props?: { openapiPath?: string; docsPath?: string }) {
  const openapiPath = props?.openapiPath ?? "/api/openapi.json";
  const docsPath = props?.docsPath ?? "/api/docs";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Service docs</CardTitle>
        <CardDescription>OpenAPI and Scalar endpoints</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 pt-0 text-xs text-muted-foreground">
        <p>
          OpenAPI: <code className="rounded bg-muted px-1 py-0.5">{openapiPath}</code>
        </p>
        <p>
          Scalar: <code className="rounded bg-muted px-1 py-0.5">{docsPath}</code>
        </p>
      </CardContent>
    </Card>
  );
}
