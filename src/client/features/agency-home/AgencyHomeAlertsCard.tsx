import type { LatestAlertCycleResult } from "@/server/features/agency/AgencyOpsArtifactsService";
import { formatRelativeFinishedAt } from "@/client/features/agency-home/agencyHomeUtils";

const DISPLAY_LIMIT = 6;

function severityBadgeClass(severity: string): string {
  const normalized = severity.toLowerCase();
  if (normalized === "high" || normalized === "critical") {
    return "badge badge-error badge-sm";
  }
  if (normalized === "medium" || normalized === "warning") {
    return "badge badge-warning badge-sm";
  }
  return "badge badge-ghost badge-sm";
}

function isParsedAlertCycle(
  data: LatestAlertCycleResult,
): data is Extract<LatestAlertCycleResult, { highAlerts: unknown }> {
  return !("parseError" in data && data.parseError);
}

export function AgencyHomeAlertsCard({
  data,
  isLoading,
  isError = false,
}: {
  data: LatestAlertCycleResult | null | undefined;
  isLoading: boolean;
  isError?: boolean;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Alerts</h2>
        {data && isParsedAlertCycle(data) ? (
          <p className="text-xs text-base-content/45">
            Received {formatRelativeFinishedAt(data.receivedAt)}
          </p>
        ) : data?.receivedAt ? (
          <p className="text-xs text-base-content/45">
            Received {formatRelativeFinishedAt(data.receivedAt)}
          </p>
        ) : null}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <span className="loading loading-spinner loading-md" />
        </div>
      ) : isError ? (
        <p className="rounded-xl border border-dashed border-error/50 bg-error/5 px-4 py-8 text-center text-sm text-error">
          Could not load alerts — try reloading the page.
        </p>
      ) : !data ? (
        <p className="rounded-xl border border-dashed border-base-300/80 bg-base-200/30 px-4 py-8 text-center text-sm text-base-content/55">
          No alert cycles received yet.
        </p>
      ) : isParsedAlertCycle(data) ? (
        <div className="space-y-4">
          {Object.keys(data.countsBySeverity).length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.countsBySeverity).map(([severity, count]) => (
                <span key={severity} className={severityBadgeClass(severity)}>
                  {severity}: {count}
                </span>
              ))}
            </div>
          ) : null}

          {data.highAlerts.length > 0 ? (
            <ul className="space-y-2">
              {data.highAlerts.slice(0, DISPLAY_LIMIT).map((alert, index) => (
                <li
                  key={`${alert.domain ?? "site-wide"}-${index}`}
                  className="text-sm text-base-content/85"
                >
                  {alert.domain ? (
                    <>
                      <span className="font-semibold">{alert.domain}</span>
                      {" — "}
                    </>
                  ) : null}
                  {alert.message}
                </li>
              ))}
              {data.highCount > DISPLAY_LIMIT ? (
                <li className="text-xs text-base-content/50">
                  +{data.highCount - DISPLAY_LIMIT} more in this cycle
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="text-sm text-base-content/55">
              No high-severity alerts in the latest cycle.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-warning">
          Latest alert cycle could not be parsed — check Operations for the raw
          artifact.
        </p>
      )}
    </section>
  );
}
