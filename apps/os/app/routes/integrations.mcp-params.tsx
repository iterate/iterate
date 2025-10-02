import { useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Shield, Eye, EyeOff } from "lucide-react";
import { z } from "zod/v4";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../components/ui/form.tsx";
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
import { AgentDurableObjectInfo } from "../../backend/auth/oauth-state-schemas.ts";
import { MCPParam } from "../../backend/agent/tool-schemas.ts";

export function meta() {
  return [
    { title: "Configure MCP Server" },
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

  const serverUrl = searchParams.get("serverUrl") || "";
  const mode = searchParams.get("mode") || "personal";
  const connectionKey = searchParams.get("connectionKey") || "";
  const requiredParamsStr = searchParams.get("requiredParams") || "[]";
  const agentDurableObject = searchParams.get("agentDurableObject") || "{}";
  const integrationSlug = searchParams.get("integrationSlug") || "";
  const finalRedirectUrl = searchParams.get("finalRedirectUrl") || undefined;

  const requiredParams = useMemo(
    () => z.array(MCPParam).parse(JSON.parse(requiredParamsStr)),
    [requiredParamsStr],
  );
  const durableObject = useMemo(
    () => AgentDurableObjectInfo.parse(JSON.parse(agentDurableObject)),
    [agentDurableObject],
  );

  const initialValues = useMemo(() => {
    const values: Record<string, string> = {};
    requiredParams.forEach((param) => {
      values[param.key] = "";
    });
    return values;
  }, [requiredParams]);

  const [showSensitive, setShowSensitive] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const form = useForm<Record<string, string>>({
    defaultValues: initialValues,
  });

  const { mutateAsync: saveParams, isPending } = useMutation(
    trpc.integrations.saveMCPConnectionParams.mutationOptions({}),
  );

  const { mutateAsync: reconnect } = useMutation(
    trpc.integrations.reconnectMCPServer.mutationOptions({}),
  );

  const handleSubmit = async (values: Record<string, string>) => {
    setError(null);

    try {
      await saveParams({
        estateId,
        connectionKey,
        params: requiredParams.map((param) => ({
          key: param.key,
          value: values[param.key],
          type: param.type,
        })),
      });

      if (
        durableObject.durableObjectName &&
        durableObject.durableObjectId &&
        durableObject.className
      ) {
        await reconnect({
          estateId,
          agentDurableObject: durableObject,
          serverUrl,
          mode: mode as "personal" | "company",
          integrationSlug,
          requiresParams: requiredParams,
        });
      }
      if (finalRedirectUrl) {
        window.location.href = finalRedirectUrl;
      } else {
        window.location.href = "/";
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
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
              {requiredParams.map((param) => (
                <FormField
                  key={param.key}
                  control={form.control}
                  name={param.key}
                  rules={{ required: "This field is required" }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex items-center gap-2">
                        {param.description}
                        {param.sensitive && <Shield className="w-3 h-3 text-muted-foreground" />}
                      </FormLabel>

                      <FormControl>
                        <div className="relative">
                          <Input
                            type={
                              param.sensitive && !showSensitive[param.key] ? "password" : "text"
                            }
                            placeholder={param.placeholder}
                            className="pr-10"
                            {...field}
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
                      </FormControl>

                      <FormDescription>
                        {param.type === "header" && "This will be sent as an HTTP header"}
                        {param.type === "query_param" &&
                          "This will be added to the server URL as a query parameter"}
                      </FormDescription>

                      <FormMessage />
                    </FormItem>
                  )}
                />
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
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
