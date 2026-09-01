export type AgencyHomePillTone =
  | "success"
  | "warning"
  | "error"
  | "muted"
  | "info";

const TONE_CLASS: Record<AgencyHomePillTone, string> = {
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  error: "bg-error/12 text-error",
  muted: "bg-base-200 text-base-content/45",
  info: "bg-primary/10 text-primary",
};

export function AgencyHomeStatusPill({
  label,
  tone,
}: {
  label: string;
  tone: AgencyHomePillTone;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium leading-tight ${TONE_CLASS[tone]}`}
    >
      {label}
    </span>
  );
}
