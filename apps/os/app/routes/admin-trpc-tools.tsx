import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import React from "react";
import { toast } from "sonner";
import { Card } from "../components/ui/card.tsx";
import { useTRPC, useTRPCClient } from "../lib/trpc.ts";
import { SerializedObjectCodeBlock } from "../components/serialized-object-code-block.tsx";

const useAllProcedureInputs = () => {
  const trpc = useTRPC();
  const { data: inputs } = useSuspenseQuery(trpc.admin.allProcedureInputs.queryOptions());
  return inputs;
};
type AllProcedureInputs = ReturnType<typeof useAllProcedureInputs>;

const ProcedureForm = (props: { path: string; inputs: AllProcedureInputs[number][1] }) => {
  const trpcClient: any = useTRPCClient();
  const [ignoreErrors, setIgnoreErrors] = React.useState<"no" | "offer" | "yes">("no");
  const { type } = (props.inputs.procedure as { _def: { type: string } })._def;
  const mutation = useMutation({
    mutationFn: async (val: {}) => {
      if (type === "mutation") {
        return trpcClient[props.path].mutation(val);
      } else if (type === "query") {
        return trpcClient[props.path].query(val);
      } else {
        throw new Error(`Unsupported procedure type: ${type}`);
      }
    },
  });
  const { $schema, ...schema } = props.inputs.parsedProcedure.optionsJsonSchema as Record<
    string,
    never
  >;
  return (
    <div className="flex flex-col gap-4">
      <style>{`
        .btn[title]:after {
          content: attr(title);
        }
      `}</style>
      <div>
        <i className="block">{props.inputs.meta?.description}</i>
      </div>
      <Form
        schema={schema as never}
        validator={
          ignoreErrors === "yes"
            ? {
                isValid: () => true,
                validateFormData: () => ({ errors: [], errorSchema: {} }),
                rawValidation: () => ({}),
                toErrorList: () => [],
              }
            : validator
        }
        onChange={(_ev) => void 0}
        onSubmit={({ formData }) => mutation.mutate(formData as {})}
        onError={(_ev) => setIgnoreErrors("offer")}
      />
      {ignoreErrors !== "no" && (
        <div className="flex flex-row gap-2">
          <input
            id={`ignore-errors-${props.path}`}
            type="checkbox"
            onChange={() => setIgnoreErrors((prev) => (prev === "offer" ? "yes" : "offer"))}
          />
          <label htmlFor={`ignore-errors-${props.path}`}>Bypass client-side errors</label>
        </div>
      )}
      <details>
        <summary>inputs</summary>
        <pre>{JSON.stringify(props, null, 2)}</pre>
      </details>
      <details open={mutation.status === "success"}>
        <summary>
          {type}: {mutation.status}
        </summary>
        <SerializedObjectCodeBlock data={mutation.data || mutation.error || mutation.status} />
      </details>
    </div>
  );
};

// todo: some kind of way of scripting/use an output of one procedure as input to another
// todo: other output renderering options. codemirror?
export default function AdminForm() {
  const inputs = useAllProcedureInputs();
  const [search, setSearch] = React.useState("admin.");
  const filteredInputs = React.useMemo(() => {
    return inputs.filter(([procedurePath]) =>
      procedurePath.toLowerCase().includes(search.toLowerCase()),
    );
  }, [inputs, search]);
  return (
    <div className="flex flex-col flex-wrap gap-3 p-2">
      <style>
        {`
          input {
            color: black;
            background: white;
            margin: 0.5rem;
            padding: 0.25rem;
          }

          button {
            background: grey;
            padding: 0.5rem;
            margin: 0.5rem;
          }
          button:hover {
            outline: 1px solid blue;
          }
        `}
      </style>
      <input
        className="flex outline-2 outline-black p-1"
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="filter procedures"
      />
      {filteredInputs.map(([procedurePath, procedureInputs]) => {
        return (
          <div key={procedurePath}>
            <details>
              <summary className="text-white">{procedurePath}</summary>
              <Card key={procedurePath} className="p-2">
                <h5 className="break-words">{procedurePath}</h5>
                <ErrorBoundary>
                  <ProcedureForm path={procedurePath} inputs={procedureInputs} />
                </ErrorBoundary>
              </Card>
            </details>
          </div>
        );
      })}
    </div>
  );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: Error) {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // You can also log the error to an error reporting service
    toast(`${error}, ${errorInfo as string}`);
  }

  render() {
    if (this.state.hasError) {
      // You can render any custom fallback UI
      return <h1>Something went wrong.</h1>;
    }

    return this.props.children;
  }
}
