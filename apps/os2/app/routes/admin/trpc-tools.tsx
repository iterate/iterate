import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";

export const Route = createFileRoute("/_auth.layout/admin/trpc-tools")({
  component: TRPCToolsPage,
});

function TRPCToolsPage() {
  const [endpoint, setEndpoint] = useState("");
  const [input, setInput] = useState("{}");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleExecute = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const parsedInput = JSON.parse(input);
      const response = await fetch(`/api/trpc/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedInput),
      });

      const data = await response.json();
      setResult(JSON.stringify(data, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">tRPC Tools</h1>

      <Card>
        <CardHeader>
          <CardTitle>Execute tRPC Procedure</CardTitle>
          <CardDescription>Test tRPC procedures directly</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium">Endpoint</label>
            <Input
              placeholder="e.g., testing.echo"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Input (JSON)</label>
            <textarea
              className="w-full h-32 border rounded-md p-2 font-mono text-sm"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </div>
          <Button onClick={handleExecute} disabled={loading}>
            {loading ? "Executing..." : "Execute"}
          </Button>

          {result && (
            <div>
              <label className="text-sm font-medium">Result</label>
              <pre className="bg-muted p-4 rounded-lg overflow-auto text-sm">{result}</pre>
            </div>
          )}

          {error && <div className="text-red-500 text-sm">Error: {error}</div>}
        </CardContent>
      </Card>
    </div>
  );
}
