import { Link, useNavigate } from "@tanstack/react-router";
import type { AgencyHomePortfolioRow } from "@/server/features/agency/AgencyHomeService";
import {
  formatCompactNumber,
  projectFaviconUrl,
} from "@/client/features/agency-home/agencyHomeUtils";

function QuietCell({ children }: { children: string }) {
  return <span className="text-sm text-base-content/40">{children}</span>;
}

function SetupPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
        ok
          ? "bg-success/10 text-success"
          : "bg-base-200 text-base-content/40"
      }`}
    >
      {label} {ok ? "✓" : "—"}
    </span>
  );
}

function DomainCell({ row }: { row: AgencyHomePortfolioRow }) {
  const favicon = projectFaviconUrl(row.domain);
  const label = row.domain ?? row.projectName;
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {favicon ? (
        <img
          src={favicon}
          alt=""
          width={16}
          height={16}
          className="size-4 shrink-0 rounded-sm"
        />
      ) : (
        <span className="size-4 shrink-0 rounded-sm bg-base-300/80" />
      )}
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
}: {
  rows: AgencyHomePortfolioRow[];
  isLoading: boolean;
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
        <div className="flex justify-center py-10">
          <span className="loading loading-spinner loading-md" />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-base-300/80 bg-base-200/30 px-4 py-8 text-center text-sm text-base-content/55">
          No projects yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-base-300/70">
          <table className="table table-sm">
            <thead>
              <tr className="border-b border-base-300/70 text-xs text-base-content/45">
                <th className="bg-base-200/40 font-medium">Client</th>
                <th className="bg-base-200/40 font-medium">Clicks</th>
                <th className="bg-base-200/40 font-medium">Impr.</th>
                <th className="bg-base-200/40 font-medium">Keywords</th>
                <th className="bg-base-200/40 font-medium">Best pos.</th>
                <th className="bg-base-200/40 font-medium">Loops</th>
                <th className="bg-base-200/40 font-medium">Setup</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.projectId}
                  className="cursor-pointer border-b border-base-300/40 transition hover:bg-base-200/30"
                  onClick={() =>
                    void navigate({
                      to: "/p/$projectId",
                      params: { projectId: row.projectId },
                    })
                  }
                >
                  <td className="max-w-[16rem]">
                    <DomainCell row={row} />
                  </td>
                  <td>
                    {!row.gscConnected ? (
                      <Link
                        to="/p/$projectId/settings/integrations"
                        params={{ projectId: row.projectId }}
                        className="badge badge-ghost badge-sm font-normal text-base-content/50"
                        onClick={(e) => e.stopPropagation()}
                      >
                        connect
                      </Link>
                    ) : row.gscClicks28d == null ? (
                      <QuietCell>not measured</QuietCell>
                    ) : (
                      <span className="tabular-nums">
                        {formatCompactNumber(row.gscClicks28d)}
                      </span>
                    )}
                  </td>
                  <td>
                    {!row.gscConnected ? (
                      <QuietCell>—</QuietCell>
                    ) : row.gscImpressions28d == null ? (
                      <QuietCell>not measured</QuietCell>
                    ) : (
                      <span className="tabular-nums">
                        {formatCompactNumber(row.gscImpressions28d)}
                      </span>
                    )}
                  </td>
                  <td>
                    {row.trackedKeywords == null ? (
                      <QuietCell>—</QuietCell>
                    ) : (
                      <span className="tabular-nums">{row.trackedKeywords}</span>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
