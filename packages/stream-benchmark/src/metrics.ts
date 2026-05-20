const APPENDS_PER_SEC_QUERY = `
SELECT
  intDiv(toUInt32(timestamp), 10) * 10 AS t,
  blob1 AS stream_path,
  SUM(_sample_interval) / 10 AS appends_per_sec
FROM stream_metrics
WHERE blob2 = 'append'
  AND timestamp > NOW() - INTERVAL '15' MINUTE
GROUP BY t, stream_path
ORDER BY t, stream_path
FORMAT JSON
`.trim();

const TOTALS_QUERY = `
SELECT
  blob1 AS stream_path,
  SUM(_sample_interval) AS appends
FROM stream_metrics
WHERE blob2 = 'append'
  AND timestamp > NOW() - INTERVAL '15' MINUTE
GROUP BY stream_path
ORDER BY appends DESC
FORMAT JSON
`.trim();

type AnalyticsSqlRow = Record<string, string | number>;

export async function queryAnalyticsEngine(args: {
  accountId: string;
  apiToken: string;
  sql: string;
}): Promise<AnalyticsSqlRow[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${args.accountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiToken}` },
      body: args.sql,
    },
  );

  if (!response.ok) {
    throw new Error(`Analytics Engine SQL failed (${response.status}): ${await response.text()}`);
  }

  const body = (await response.json()) as {
    data?: AnalyticsSqlRow[];
    errors?: { message: string }[];
  };
  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join("; "));
  }
  return body.data ?? [];
}

export async function renderMetricsPage(env: Env): Promise<Response> {
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;

  if (!accountId || !apiToken) {
    return new Response(renderSetupHtml(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  try {
    const [series, totals] = await Promise.all([
      queryAnalyticsEngine({ accountId, apiToken, sql: APPENDS_PER_SEC_QUERY }),
      queryAnalyticsEngine({ accountId, apiToken, sql: TOTALS_QUERY }),
    ]);
    return new Response(renderChartHtml({ series, totals }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(renderErrorHtml({ message }), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

function renderSetupHtml(): string {
  return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>stream-benchmark metrics</title></head>
  <body>
    <h1>stream_metrics</h1>
    <p>Analytics Engine writes are live from the Stream DO. To render charts here, set:</p>
    <pre>pnpm wrangler secret put CF_API_TOKEN   # Account Analytics Read
# optional if not in wrangler vars:
pnpm wrangler secret put CF_ACCOUNT_ID</pre>
    <p>Or query from the CLI: <code>pnpm query-metrics</code></p>
    <p>
      <strong>Cloudflare dashboard graphs (Workers Logs):</strong>
      Workers &amp; Pages → stream-benchmark → Observability → Overview.
      Filter message contains <code>stream.append</code>, visualization Count, group by streamPath
      (or use saved query after first benchmark).
    </p>
  </body>
</html>`;
}

function renderErrorHtml(args: { message: string }): string {
  return `<!DOCTYPE html>
<html><body><h1>Metrics query failed</h1><pre>${escapeHtml(args.message)}</pre></body></html>`;
}

function renderChartHtml(args: { series: AnalyticsSqlRow[]; totals: AnalyticsSqlRow[] }): string {
  const totals = args.totals.map((row) => ({
    stream_path: String(row.stream_path),
    appends: Number(row.appends),
  }));
  const topChartPaths = new Set(
    totals
      .filter((row) => row.appends > 0)
      .slice(0, 8)
      .map((row) => row.stream_path),
  );

  const payload = JSON.stringify({
    series: args.series
      .filter((row) => topChartPaths.has(String(row.stream_path)))
      .map((row) => ({
        t: Number(row.t),
        stream_path: String(row.stream_path),
        appends_per_sec: Number(row.appends_per_sec),
      })),
    totals,
    chartStreamCount: topChartPaths.size,
    totalStreamCount: totals.length,
  });

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>stream-benchmark — appends/sec</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 960px; }
      canvas { max-height: 420px; }
      table { border-collapse: collapse; margin-top: 1.5rem; width: 100%; }
      th, td { border: 1px solid #ccc; padding: 0.4rem 0.8rem; text-align: left; }
      .note { color: #444; font-size: 0.95rem; line-height: 1.5; }
    </style>
  </head>
  <body>
    <h1>Appends per second (10s buckets)</h1>
    <p class="note">
      Each point is <strong>committed appends</strong> on that Durable Object (stream path),
      averaged over a 10-second window. Flat zero = no traffic in that window. The table is
      total appends in the last 15 minutes. Chart shows the top 8 busiest streams.
    </p>
    <p>Dataset <code>stream_metrics</code>. Refreshes every 30s.</p>
    <canvas id="chart"></canvas>
    <table>
      <thead><tr><th>Stream path</th><th>Appends (15m)</th></tr></thead>
      <tbody id="totals"></tbody>
    </table>
    <script>
      const data = ${payload};
      const byStream = new Map();
      for (const row of data.series) {
        if (!byStream.has(row.stream_path)) byStream.set(row.stream_path, []);
        byStream.get(row.stream_path).push({
          x: row.t * 1000,
          y: row.appends_per_sec,
        });
      }
      const colors = ["#ca8a04", "#2563eb", "#dc2626", "#16a34a", "#9333ea", "#0891b2", "#ea580c", "#4f46e5"];
      const datasets = [...byStream.entries()].map(([label, points], i) => ({
        label,
        data: points.sort((a, b) => a.x - b.x),
        borderColor: colors[i % colors.length],
        backgroundColor: colors[i % colors.length] + "33",
        fill: false,
        tension: 0.1,
      }));
      new Chart(document.getElementById("chart"), {
        type: "line",
        data: { datasets },
        options: {
          interaction: { mode: "nearest", axis: "x", intersect: false },
          plugins: {
            legend: { position: "bottom" },
            tooltip: {
              callbacks: {
                title: (items) => new Date(items[0].parsed.x).toLocaleString(),
                label: (item) =>
                  item.dataset.label + ": " + item.parsed.y.toFixed(1) + " appends/s (10s avg)",
              },
            },
          },
          scales: {
            x: {
              type: "time",
              time: { tooltipFormat: "HH:mm:ss", displayFormats: { second: "HH:mm:ss" } },
              title: { display: true, text: "Time (UTC bucket start)" },
            },
            y: {
              title: { display: true, text: "appends/sec (10s average)" },
              beginAtZero: true,
            },
          },
        },
      });
      const tbody = document.getElementById("totals");
      for (const row of data.totals) {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + row.stream_path + "</td><td>" + row.appends.toLocaleString() + "</td>";
        tbody.appendChild(tr);
      }
      setInterval(() => location.reload(), 30000);
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
