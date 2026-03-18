export function InfoRow({
  label,
  value,
  selectable,
}: {
  label: string;
  value: string;
  selectable?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`truncate ml-4 max-w-[240px] text-right font-mono text-xs${selectable ? " select-all" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
