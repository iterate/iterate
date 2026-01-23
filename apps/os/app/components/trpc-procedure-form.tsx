import Form from "@rjsf/core";
import type { RJSFSchema, ValidatorType } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import { useMutation } from "@tanstack/react-query";
import { useState, Component, type ReactNode } from "react";
import { toast } from "sonner";
import { Card } from "./ui/card.tsx";

// A validator that always passes - used when bypassing client-side validation
const noopValidator: ValidatorType = {
  isValid: () => true,
  validateFormData: () => ({ errors: [], errorSchema: {} }),
  rawValidation: () => ({}),
};

export interface ProcedureInputs {
  procedure: { _def: { type: string } };
  parsedProcedure: { optionsJsonSchema: Record<string, unknown> };
  meta?: { description?: string };
}

interface ProcedureFormProps {
  path: string;
  inputs: ProcedureInputs;
  /** Function to execute the procedure. Receives the path and form data, returns the result */
  executeProcedure: (
    path: string,
    type: "query" | "mutation",
    data: Record<string, unknown>,
  ) => Promise<unknown>;
}

export function ProcedureForm({ path, inputs, executeProcedure }: ProcedureFormProps) {
  const [ignoreErrors, setIgnoreErrors] = useState<"no" | "offer" | "yes">("no");
  const type = inputs.procedure._def.type as "query" | "mutation";

  const mutation = useMutation({
    mutationFn: async (val: Record<string, unknown>) => {
      return executeProcedure(path, type, val);
    },
  });

  const { $schema: _schema, ...schema } = inputs.parsedProcedure.optionsJsonSchema as Record<
    string,
    unknown
  >;

  return (
    <div className="flex flex-col gap-4">
      <style>{`
        .rjsf .btn[title]:after {
          content: attr(title);
        }
        .rjsf input, .rjsf select, .rjsf textarea {
          color: hsl(var(--foreground));
          background: hsl(var(--background));
          border: 1px solid hsl(var(--border));
          border-radius: 0.375rem;
          padding: 0.5rem;
          margin: 0.25rem 0;
          width: 100%;
        }
        .rjsf button {
          background: hsl(var(--primary));
          color: hsl(var(--primary-foreground));
          padding: 0.5rem 1rem;
          border-radius: 0.375rem;
          margin-top: 0.5rem;
        }
        .rjsf button:hover {
          opacity: 0.9;
        }
        .rjsf label {
          font-weight: 500;
          display: block;
          margin-bottom: 0.25rem;
          font-size: 0.875rem;
        }
        .rjsf .field-description {
          font-size: 0.75rem;
          color: hsl(var(--muted-foreground));
        }
      `}</style>
      {inputs.meta?.description && (
        <p className="text-sm text-muted-foreground italic">{inputs.meta.description}</p>
      )}
      <Form
        className="rjsf"
        schema={schema as RJSFSchema}
        validator={ignoreErrors === "yes" ? noopValidator : validator}
        onChange={() => void 0}
        onSubmit={({ formData }) => mutation.mutate(formData as Record<string, unknown>)}
        onError={() => setIgnoreErrors("offer")}
      />
      {ignoreErrors !== "no" && (
        <div className="flex items-center gap-2">
          <input
            id={`ignore-errors-${path}`}
            type="checkbox"
            className="h-4 w-4"
            checked={ignoreErrors === "yes"}
            onChange={() => setIgnoreErrors((prev) => (prev === "offer" ? "yes" : "offer"))}
          />
          <label htmlFor={`ignore-errors-${path}`} className="text-sm">
            Bypass client-side validation errors
          </label>
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">Schema</summary>
        <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-auto max-h-48">
          {JSON.stringify(inputs, null, 2)}
        </pre>
      </details>
      <details open={mutation.status === "success" || mutation.status === "error"}>
        <summary className="cursor-pointer text-sm">
          {type}:{" "}
          <span className={mutation.isError ? "text-destructive" : ""}>{mutation.status}</span>
        </summary>
        <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-auto max-h-96">
          {JSON.stringify(mutation.data ?? mutation.error ?? mutation.status, null, 2)}
        </pre>
      </details>
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class ProcedureErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    toast.error(`Error in procedure form: ${error.message}`);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 border border-destructive rounded bg-destructive/10">
          <h4 className="font-medium text-destructive">Something went wrong</h4>
          <p className="text-sm text-muted-foreground">{this.state.error?.message}</p>
        </div>
      );
    }

    return this.props.children;
  }
}

interface TrpcToolsSectionProps {
  /** Array of [path, procedureInputs] tuples */
  procedures: Array<[string, ProcedureInputs]>;
  /** Function to execute procedures */
  executeProcedure: (
    path: string,
    type: "query" | "mutation",
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Initial search filter */
  initialSearch?: string;
  /** Title for the section */
  title?: string;
}

export function TrpcToolsSection({
  procedures,
  executeProcedure,
  initialSearch = "",
  title = "tRPC Tools",
}: TrpcToolsSectionProps) {
  const [search, setSearch] = useState(initialSearch);

  const filteredProcedures = procedures.filter(([procedurePath]) =>
    procedurePath.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      {title && <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Filter procedures..."
        className="w-full max-w-md px-3 py-2 text-sm border rounded-md bg-background"
      />
      <p className="text-xs text-muted-foreground">
        {filteredProcedures.length} of {procedures.length} procedures
      </p>

      <div className="space-y-2">
        {filteredProcedures.map(([procedurePath, procedureInputs]) => {
          const type = procedureInputs.procedure._def.type;
          return (
            <details key={procedurePath}>
              <summary className="cursor-pointer py-2 px-3 rounded hover:bg-accent text-sm">
                <span className="font-mono">{procedurePath}</span>
                <span className="ml-2 text-xs text-muted-foreground">({type})</span>
              </summary>
              <Card className="ml-4 mt-2 p-4">
                <ProcedureErrorBoundary>
                  <ProcedureForm
                    path={procedurePath}
                    inputs={procedureInputs}
                    executeProcedure={executeProcedure}
                  />
                </ProcedureErrorBoundary>
              </Card>
            </details>
          );
        })}
      </div>
    </div>
  );
}
