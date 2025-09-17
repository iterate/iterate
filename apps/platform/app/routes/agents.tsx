import { useState } from "react";
import { useParams, Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { trpc } from "../lib/trpc.ts";
import { DashboardLayout } from "../components/dashboard-layout.tsx";
import { Button } from "../components/ui/button.tsx";

export default function AgentsPage() {
  const params = useParams();
  const { agentClassName, durableObjectName } = params;
  const [message, setMessage] = useState("");
  const utils = trpc.useUtils();

  // Get agent state
  const [agentState] = trpc.agents.getState.useSuspenseQuery({
    agentInstanceName: durableObjectName!,
    agentClassName: agentClassName! as "IterateAgent",
  });

  // Add events mutation
  const addEventsMutation = trpc.agents.addEvents.useMutation({
    onSuccess: () => {
      // Refetch the agent state after adding events
      utils.agents.getState.invalidate({
        agentInstanceName: durableObjectName!,
        agentClassName: agentClassName! as "IterateAgent",
      });
    },
  });

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) {
      return;
    }

    // Create a user message input item event as per agent-core-schemas.ts
    const userMessageEvent = {
      type: "CORE:LLM_INPUT_ITEM" as const,
      data: {
        type: "message" as const,
        role: "user" as const,
        content: [
          {
            type: "input_text" as const,
            text: message,
          },
        ],
      },
      triggerLLMRequest: true,
    };

    try {
      await addEventsMutation.mutateAsync({
        agentInstanceName: durableObjectName!,
        agentClassName: agentClassName! as "IterateAgent",
        events: [userMessageEvent],
      });
      setMessage(""); // Clear the input after successful send
    } catch (error) {
      console.error("Failed to send message:", error);
    }
  };

  return (
    <DashboardLayout>
      <div className="p-6">
        <div className="max-w-4xl mx-auto">
          {/* Back navigation */}
          <div className="mb-6">
            <Link to="/agents">
              <Button variant="ghost" className="mb-4">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Agents
              </Button>
            </Link>
            <h1 className="text-2xl font-bold">
              Agent: {agentClassName}/{durableObjectName}
            </h1>
          </div>

      {/* Message input form */}
      <form onSubmit={handleSendMessage} className="mb-6">
        <div className="flex gap-2">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Send a message to the agent..."
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={addEventsMutation.isPending}
          />
          <button
            type="submit"
            disabled={addEventsMutation.isPending || !message.trim()}
            className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {addEventsMutation.isPending ? "Sending..." : "Send"}
          </button>
        </div>
      </form>

      {/* Agent state display */}
      <div className="bg-gray-50 p-4 rounded-lg">
        <h2 className="text-lg font-semibold mb-3">Agent State</h2>
        <pre className="bg-white p-4 rounded border overflow-auto max-h-96 text-sm">
          {JSON.stringify(agentState, null, 2)}
        </pre>
      </div>

      {/* Error display */}
      {addEventsMutation.error && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <h3 className="text-red-800 font-medium">Error sending message:</h3>
          <p className="text-red-700 text-sm mt-1">
            {addEventsMutation.error instanceof Error
              ? addEventsMutation.error.message
              : "An unknown error occurred"}
          </p>
          </div>
        )}
        </div>
      </div>
    </DashboardLayout>
  );
}
