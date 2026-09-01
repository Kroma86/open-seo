import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { AgencyHomePortfolioRow } from "@/server/features/agency/AgencyHomeService";
import {
  formatCompactNumber,
  portfolioRowStatus,
} from "@/client/features/agency-home/agencyHomeUtils";
import { AgencyHomeProjectAvatar } from "@/client/features/agency-home/AgencyHomeProjectAvatar";
import { AgencyHomeStatusPill } from "@/client/features/agency-home/AgencyHomeStatusPill";

function QuietCell({ children }: { children: string }) {
  return <span className="text-sm tabular-nums text-base-content/40">{children}</span>;
}

function SetupPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <AgencyHomeStatusPill
      label={ok ? `${label} ✓` : `${label} —`}
      tone={ok ? "success" : "muted"}
    />
  );
}

function TrafficCell({
  row,
}: {
  row: AgencyHomePortfolioRow;
}) {
  if (!row.gscConnected) {
    return (
      <Link
        to="/p/$projectId/settings/integrations"
        params={{ projectId: row.projectId }}
        className="inline-flex"
        onClick={(e) => e.stopPropagation()}
      >
        <AgencyHomeStatusPill label="connect" tone="muted" />
      </Link>
    );
  }

  if (row.gscClicks28d == null) {
    return <QuietCell>not measured</QuietCell>;
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-medium tabular-nums text-base-content">
        {formatCompactNumber(row.gscClicks28d)}
        <span className="ml-1 text-xs font-normal text-base-content/45">
          clicks
        </span>
      </span>
      {row.gscImpressions28d != null ? (
        <span className="text-xs tabular-nums text-base-content/45">
          {formatCompactNumber(row.gscImpressions28d)} impr.
        </span>
      ) : (
        <span className="text-xs text-base-content/40">impr. not measured</span>
      )}
    </div>
  );
}

function DomainCell({ row }: { row: AgencyHomePortfolioRow }) {
  const label = row.domain ?? row.projectName;
  return (
    <span className="flex min-w-0 items-center gap-3">
      <AgencyHomeProjectAvatar domain={row.domain} projectName={row.projectName} />
      <span className="min-w-0">
        <span className="block truncate font-medium text-base-content">
          {label}
        </span>
        {row.domain && row.projectName !== row.domain ? (
          <span className="block truncate text-xs text-base-content/45">
            {row.projectName}
          </span>
        ) : null}
      </span>
    </span>
  );
}

export function AgencyHomePortfolioTable({
  rows,
  isLoading,
  runningProjectIds = new Set<string>(),
}: {
  rows: AgencyHomePortfolioRow[];
  isLoading: boolean;
  runningProjectIds?: Set<string>;
}) {
  const navigate = useNavigate();

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Portfolio</h2>
        <p className="text-xs text-base-content/45">
          Last 28 days · real sources only
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center rounded-xl border border-base-300/70 bg-base-100 py-10">
          <span className="loading loading-spinner loading-md" />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-base-300/80 bg-base-200/30 px-4 py-8 text-center text-sm text-base-content/55">
          No projects yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-base-300/70 bg-base-100">
          <table className="table table-sm">
            <thead>
              <tr className="border-b border-base-300/70 text-xs text-base-content/45">
                <th className="bg-base-200/40 font-medium">Client</th>
                <th className="bg-base-200/40 font-medium">Status</th>
                <th className="bg-base-200/40 font-medium">Traffic</th>
                <th className="bg-base-200/40 font-medium">Keywords</th>
                <th className="bg-base-200/40 font-medium">Best pos.</th>
                <th className="bg-base-200/40 font-medium">Loops</th>
                <th className="bg-base-200/40 font-medium">Setup</th>
                <th className="bg-base-200/40 w-8" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const status = portfolioRowStatus(
                  row,
                  runningProjectIds.has(row.projectId),
                );
                return (
                  <tr
                    key={row.projectId}
                    className="group cursor-pointer border-b border-base-300/40 transition-colors hover:bg-base-200/40"
                    onClick={() =>
                      void navigate({
                        to: "/p/$projectId",
                        params: { projectId: row.projectId },
                      })
                    }
                  >
                    <td className="max-w-[14rem]">
                      <DomainCell row={row} />
                    </td>
                    <td>
                      <AgencyHomeStatusPill
                        label={status.label}
                        tone={status.tone}
                      />
                    </td>
                    <td>
                      <TrafficCell row={row} />
                    </td>
                    <td>
                      {row.trackedKeywords == null ? (
                        <QuietCell>—</QuietCell>
                      ) : (
                        <span className="tabular-nums">
                          {row.trackedKeywords}
                        </span>
                      )}
                    </td>
                    <td>
                      {row.bestPosition == null ? (
                        <QuietCell>—</QuietCell>
                      ) : (
                        <span className="tabular-nums">#{row.bestPosition}</span>
                      )}
                    </td>
                    <td>
                      {row.loopsActive == null ? (
                        <QuietCell>—</QuietCell>
                      ) : (
                        <span className="tabular-nums">{row.loopsActive}</span>
                      )}
                    </td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        <SetupPill ok={row.setup.gsc} label="GSC" />
                        <SetupPill ok={row.setup.loops} label="Loops" />
                      </span>
                    </td>
                    <td className="w-8 pr-2">
                      <ChevronRight
                        className="size-4 text-base-content/25 transition group-hover:text-primary/70"
                        aria-hidden
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
