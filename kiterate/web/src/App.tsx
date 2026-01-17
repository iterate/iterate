import { useEffect, useState } from "react";
import { AgentChat } from "@/components/AgentChat";

export function App() {
  const [streamName, setStreamName] = useState<string | null>(null);

  useEffect(() => {
    // Get stream name from URL path (e.g., /my-stream -> "my-stream")
    const path = window.location.pathname.slice(1); // Remove leading /
    if (path) {
      setStreamName(path);
    }

    // Listen for popstate (back/forward navigation)
    const handlePopState = () => {
      const newPath = window.location.pathname.slice(1);
      setStreamName(newPath || null);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  if (!streamName) {
    return (
      <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">kiterate</h1>
          <p className="text-gray-400">Navigate to /{"{stream-name}"} to open a stream</p>
          <p className="text-gray-500 text-sm">Example: /my-agent-session</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-900 text-gray-100">
      <AgentChat streamName={streamName} />
    </div>
  );
}
