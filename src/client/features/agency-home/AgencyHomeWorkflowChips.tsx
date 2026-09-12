import {
  AGENCY_WORKFLOW_CHIPS,
  type AgencyWorkflowChip,
} from "@/client/features/agency-home/workflowChips";

export function AgencyHomeWorkflowChips({
  onSelect,
}: {
  onSelect: (chip: AgencyWorkflowChip) => void;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-base-content/45">
        Workflows
      </h2>
      <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {AGENCY_WORKFLOW_CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="btn btn-sm shrink-0 border border-base-300/70 bg-base-100 font-normal text-base-content/80 shadow-none hover:border-primary/30 hover:bg-primary/5 hover:text-base-content"
            onClick={() => onSelect(chip)}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </section>
  );
}
