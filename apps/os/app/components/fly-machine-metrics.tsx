import { PrometheusUplotChart } from "./prometheus-uplot-chart.tsx";

type FlyMachineMetricsProps = {
  projectSlug: string;
  machineId: string;
  flyMachineId: string;
};

function formatCpuCores(value: number): string {
  return `${value.toFixed(2)}`;
}

function formatBytesAsMib(value: number): string {
  const mib = value / 1024 / 1024;
  if (mib >= 1024) return `${(mib / 1024).toFixed(2)} GiB`;
  return `${mib.toFixed(0)} MiB`;
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function FlyMachineMetrics({
  projectSlug,
  machineId,
  flyMachineId,
}: FlyMachineMetricsProps) {
  const escapedMachineId = escapeLabelValue(flyMachineId);
  const machineSelector = `instance="${escapedMachineId}"`;

  const machineCpuQuery = `sum(rate(fly_instance_cpu{${machineSelector},mode!="idle"}[5m])) / 100`;
  const machineMemoryQuery = `fly_instance_memory{${machineSelector}}`;
  const processCpuQuery = `topk(5, sum by (groupname) (rate(namedprocess_namegroup_cpu_seconds_total{${machineSelector}}[5m])))`;
  const processMemoryQuery = `topk(5, namedprocess_namegroup_memory_bytes{${machineSelector},memtype="resident"})`;

  return (
    <section className="space-y-3">
      <PrometheusUplotChart
        title="Machine CPU (cores)"
        projectSlug={projectSlug}
        machineId={machineId}
        query={machineCpuQuery}
        yAxisLabel="CPU cores"
        formatValue={formatCpuCores}
        noDataMessage="No CPU metrics found for this machine yet."
        getSeriesLabel={() => "CPU"}
      />
      <PrometheusUplotChart
        title="Machine Memory"
        projectSlug={projectSlug}
        machineId={machineId}
        query={machineMemoryQuery}
        yAxisLabel="Memory"
        formatValue={formatBytesAsMib}
        noDataMessage="No memory metrics found for this machine yet."
        getSeriesLabel={() => "Memory"}
      />
      <PrometheusUplotChart
        title="Top Processes by CPU (cores)"
        projectSlug={projectSlug}
        machineId={machineId}
        query={processCpuQuery}
        yAxisLabel="CPU cores"
        formatValue={formatCpuCores}
        noDataMessage="Process-level metrics are not available for this machine yet."
        getSeriesLabel={(metric, index) => metric.groupname ?? `Process ${index + 1}`}
      />
      <PrometheusUplotChart
        title="Top Processes by Memory (RSS)"
        projectSlug={projectSlug}
        machineId={machineId}
        query={processMemoryQuery}
        yAxisLabel="Memory"
        formatValue={formatBytesAsMib}
        noDataMessage="Process-level metrics are not available for this machine yet."
        getSeriesLabel={(metric, index) => metric.groupname ?? `Process ${index + 1}`}
      />
    </section>
  );
}
