## Exposing Local Servers (Port Forwarding)

This sandbox runs on Daytona with built-in port proxying. Traditional tunneling tools (ngrok, localtunnel, cloudflared, bore, etc.) will NOT work due to TLS certificate interception by the egress proxy.

**To expose a local server:**

1. Start your dev server on any port (e.g., `npx serve -l 3000`)
2. The public URL is: `https://{PORT}-{DAYTONA_SANDBOX_ID}.proxy.daytona.works`

**Example:**

```bash
# Create and start a Vite project
npm create vite@latest my-app -- --template react
cd my-app && npm install && npm run dev -- --port 3000 &

# Get the public URL
echo "https://3000-$DAYTONA_SANDBOX_ID.proxy.daytona.works"
```

The `DAYTONA_SANDBOX_ID` environment variable is automatically set.
