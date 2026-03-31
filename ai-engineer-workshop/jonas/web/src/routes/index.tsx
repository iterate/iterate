import { createFileRoute } from "@tanstack/react-router";

import { Button } from "#/components/ui/button.tsx";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-2xl font-semibold">hello world</p>
      <Button type="button">shadcn Button</Button>
    </div>
  );
}
