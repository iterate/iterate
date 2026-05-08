import {
  JsonSchemaViewer,
  JsonSchemaViewerErrorBoundary,
  type JSONSchema,
} from "cf-json-schema-viz";

export function JsonSchemaDocViewer({ schema }: { schema: unknown }) {
  return (
    <JsonSchemaViewerErrorBoundary fallback={<JsonSchemaFallback schema={schema} />}>
      <JsonSchemaViewer
        schema={schema as JSONSchema}
        defaultExpandedDepth={2}
        disableCrumbs
        skipTopLevelDescription
        emptyText="No payload schema defined."
        className="rounded-md border bg-background py-2"
      />
    </JsonSchemaViewerErrorBoundary>
  );
}

function JsonSchemaFallback({ schema }: { schema: unknown }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted p-3 font-mono text-xs">
      {JSON.stringify(schema, null, 2)}
    </pre>
  );
}
