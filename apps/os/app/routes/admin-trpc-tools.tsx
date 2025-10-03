"use client";
// import "bootstrap/dist/css/bootstrap.min.css";
import { useLocalStorageValue } from "@react-hookz/web";
import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import React from "react";
import { toast } from "sonner";
import { Card } from "../components/ui/card.tsx";
import { useTRPC } from "../lib/trpc.ts";
// import type { AllProcedureInputs } from "./page";

// const schema: RJSFSchema = {
//   title: 'Todo',
//   type: 'object',
//   required: ['title'],
//   properties: {
//     title: {type: 'string', title: 'Title', default: 'A new task'},
//     done: {type: 'boolean', title: 'Done?', default: false},
//   },
// }

const useAllProcedureInputs = () => {
  const trpc = useTRPC();
  const { data: inputs } = useSuspenseQuery(trpc.admin.allProcedureInputs.queryOptions());
  return inputs;
};
type AllProcedureInputs = ReturnType<typeof useAllProcedureInputs>;

const ProcedureForm = (props: { path: string; inputs: AllProcedureInputs[number][1] }) => {
  const [ignoreErrors, setIgnoreErrors] = React.useState<"no" | "offer" | "yes">("no");
  const { type } = (props.inputs.procedure as { _def: { type: string } })._def;
  const mutation = useMutation({
    mutationFn: async (val: {}) => {
      let res: Response;
      const pathname = `/api/trpc/${props.path}`;
      if (type === "mutation") {
        res = await fetch(pathname, {
          method: "POST",
          body: JSON.stringify(val),
          headers: {
            "Content-Type": "application/json",
          },
        });
      } else if (type === "query") {
        res = await fetch(`${pathname}?input=${encodeURIComponent(JSON.stringify(val))}`);
      } else {
        throw new Error(`Unsupported procedure type: ${type}`);
      }
      if (!res.ok) {
        const text = await res.text();
        if (text.startsWith("{")) {
          const json = JSON.parse(text) as { error?: { message?: string } };
          if (typeof json.error?.message === "string") {
            throw new Error(json.error.message);
          }
        }
        throw new Error(text);
      }
      const json = (await res.json()) as { result?: { data?: {} } };
      if ("result" in json && json.result && "data" in json.result) {
        return json.result.data;
      }

      return { unexpectedResponseFormat: json };
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
        <DataRenderer path={props.path} data={mutation.data || mutation.error || mutation.status} />
      </details>
    </div>
  );
};

const DataRenderer = ({ path, data: inputData }: { path: string; data: unknown }) => {
  const { value: evalExpression, set: setEvalExpression } = useLocalStorageValue(
    `${path}:data-renderer-expression`,
    {
      defaultValue: "data",
    },
  );
  const result = React.useMemo(() => {
    let output = inputData;
    let problem = "";
    try {
      output = eval(`(data => ${evalExpression})(${JSON.stringify(inputData, null, 2)})`) as never;
    } catch (error) {
      problem = String(error);
    }
    if (typeof output === "function") {
      problem = "output is a function";
      output = inputData;
    }
    if (output === undefined) {
      problem = "output is undefined - return null if you really want a nullish output";
      output = inputData;
    }
    const invalidTypes = new Set(["function", "symbol", "bigint", "undefined"]);
    const detectedInvalidTypes = new Set();
    let pretty = JSON.stringify(
      output,
      (key, value: unknown) => {
        if (invalidTypes.has(typeof value)) detectedInvalidTypes.add(typeof value);
        return value;
      },
      2,
    );
    if (detectedInvalidTypes.size > 0) {
      problem = `output contains invalid types: ${Array.from(detectedInvalidTypes).join(", ")}. If this is intended, convert to JSON manually.`;
      output = inputData;
      pretty = JSON.stringify(output, null, 2);
    }
    return { output, problem, pretty };
  }, [evalExpression, inputData]);
  return (
    <>
      <input
        className="flex outline-2 outline-black p-1 w-full"
        type="text"
        value={evalExpression}
        onChange={(e) => setEvalExpression(e.target.value || "data")}
      />
      {result.problem && <pre className="text-red-500">{result.problem}</pre>}
      <pre className="max-w-5xl whitespace-pre-wrap">{result.pretty}</pre>
    </>
  );
};

// todo: some kind of jsonpath syntax to use an output of one procedure as input to another
// todo: various output renderering options. codemirror?
export default function AdminForm() {
  const inputs = useAllProcedureInputs();
  const [search, setSearch] = React.useState("");
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
      {inputs
        .slice(0, 1000)
        .filter(
          ([procedurePath]) =>
            procedurePath.includes("admin.") &&
            procedurePath.toLowerCase().includes(search.toLowerCase()),
        )
        .map(([procedurePath, procedureInputs]) => {
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
