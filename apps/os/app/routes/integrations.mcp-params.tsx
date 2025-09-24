import { useState, useEffect, useMemo } from "react";
import { Form, useNavigate, useSearchParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { Shield, Eye, EyeOff } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../components/ui/card.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import { useTRPC } from "../lib/trpc.ts";
import { useEstateId } from "../hooks/use-estate.ts";
interface RequiredParam {
  key: string;
  type: "header" | "query_param";
  placeholder: string;
  description: string;
  sensitive: boolean;
}

export function meta() {
  return [
    { title: "Configure MCP Server - Iterate Dashboard" },
    {
      name: "description",
      content: "Configure authentication parameters for MCP server connection",
    },
  ];
}

export default function MCPParams() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const estateId = useEstateId();
  const trpc = useTRPC();

  // Get parameters from URL
  const serverUrl = searchParams.get("serverUrl") || "";
  const mode = searchParams.get("mode") || "personal";
  const connectionKey = searchParams.get("connectionKey") || "";
  const requiredParamsStr = searchParams.get("requiredParams") || "[]";
  const agentDurableObject = searchParams.get("agentDurableObject") || "{}";
  const integrationSlug = searchParams.get("integrationSlug") || "";

  // Parse required params with useMemo to prevent infinite re-renders
  const requiredParams: RequiredParam[] = useMemo(
    () => JSON.parse(requiredParamsStr),
    [requiredParamsStr],
  );
  const durableObject = useMemo(() => JSON.parse(agentDurableObject), [agentDurableObject]);

  // State for form values
  const [values, setValues] = useState<Record<string, string>>({});
  const [showSensitive, setShowSensitive] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // Initialize form values
  useEffect(() => {
    const initialValues: Record<string, string> = {};
    requiredParams.forEach((param) => {
      initialValues[param.key] = "";
    });
    setValues(initialValues);
  }, [requiredParams]);

  // Mutation to save parameters
  const { mutateAsync: saveParams, isPending } = useMutation(
    trpc.integrations.saveMCPConnectionParams.mutationOptions({}),
  );

  // Mutation to reconnect MCP server
  const { mutateAsync: reconnect } = useMutation(
    trpc.integrations.reconnectMCPServer.mutationOptions({}),
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate all fields are filled
    const missingFields = requiredParams.filter((param) => !values[param.key]?.trim());
    if (missingFields.length > 0) {
      setError(
        `Please fill in all required fields: ${missingFields.map((f) => f.description).join(", ")}`,
      );
      return;
    }

    try {
      // Save parameters
      await saveParams({
        estateId,
        connectionKey,
        params: requiredParams.map((param) => ({
          key: param.key,
          value: values[param.key],
          type: param.type,
        })),
      });

      // Trigger reconnection to the agent
      if (durableObject.name && durableObject.id && durableObject.className) {
        await reconnect({
          estateId,
          agentDurableObject: durableObject,
          serverUrl,
          mode: mode as "personal" | "company",
          integrationSlug,
        });
      }

      // Navigate back to integrations or close window
      if (window.opener) {
        window.close();
      } else {
        navigate("/integrations");
      }
    } catch (err) {
      setError("Failed to save parameters. Please try again.");
      console.error("Error saving MCP params:", err);
    }
  };

  const toggleSensitive = (key: string) => {
    setShowSensitive((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Configure MCP Server</h1>
        <p className="text-muted-foreground text-lg">
          Enter the required authentication parameters for {serverUrl}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Authentication Parameters</CardTitle>
          <CardDescription>
            These parameters will be securely stored and used to authenticate with the MCP server.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <Form onSubmit={handleSubmit} className="space-y-6">
            {requiredParams.map((param) => (
              <div key={param.key} className="space-y-2">
                <Label htmlFor={param.key} className="flex items-center gap-2">
                  {param.description}
                  {param.sensitive && <Shield className="w-3 h-3 text-muted-foreground" />}
                </Label>

                <div className="relative">
                  <Input
                    id={param.key}
                    type={param.sensitive && !showSensitive[param.key] ? "password" : "text"}
                    placeholder={param.placeholder}
                    value={values[param.key] || ""}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [param.key]: e.target.value }))
                    }
                    required
                    className="pr-10"
                  />

                  {param.sensitive && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3"
                      onClick={() => toggleSensitive(param.key)}
                    >
                      {showSensitive[param.key] ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </Button>
                  )}
                </div>

                {param.type === "header" && (
                  <p className="text-xs text-muted-foreground">
                    This will be sent as an HTTP header
                  </p>
                )}
                {param.type === "query_param" && (
                  <p className="text-xs text-muted-foreground">
                    This will be added to the server URL as a query parameter
                  </p>
                )}
              </div>
            ))}

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex gap-3">
              <Button type="submit" disabled={isPending} className="flex-1">
                {isPending ? "Saving..." : "Save and Connect"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(-1)}
                disabled={isPending}
              >
                Cancel
              </Button>
            </div>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
