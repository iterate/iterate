import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button.tsx'
import { useTRPC } from '@/integrations/trpc/react.ts'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const trpc = useTRPC()
  const [enabled, setEnabled] = useState(false)

  const { data, isLoading } = useQuery({
    ...trpc.hello.queryOptions(),
    enabled,
  })

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold">Welcome to TanStack Start</h1>
      <p className="text-muted-foreground text-lg">
        Edit <code className="bg-muted px-2 py-1 rounded">src/routes/index.tsx</code> to get started
      </p>
      <Button size="lg" onClick={() => setEnabled(true)} disabled={isLoading}>
        {isLoading ? 'Loading...' : 'Call tRPC'}
      </Button>
      {data && (
        <p className="text-xl font-medium text-green-600">
          Response: {data.message}
        </p>
      )}
    </div>
  )
}
