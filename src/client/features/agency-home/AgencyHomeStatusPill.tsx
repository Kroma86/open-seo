export type AgencyHomePillTone =
  | "success"
  | "warning"
  | "error"
  | "muted"
  | "info";

// Solid daisyUI color + matching -content text: theme-owned contrast in both
// light and dark. Tinted text-on-transparent failed WCAG AA on light themes.
const TONE_CLASS: Record<AgencyHomePillTone, string> = {
  success: "bg-success text-success-content",
  warning: "bg-warning text-warning-content",
  error: "bg-error text-error-content",
  muted: "bg-base-200 text-base-content/70",
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
