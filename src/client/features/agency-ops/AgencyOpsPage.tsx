import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Markdown } from "@/client/components/Markdown";
import { formatRelativeFinishedAt } from "@/client/features/agency-home/agencyHomeUtils";
import {
  getOpsArtifact,
  listOpsArtifacts,
} from "@/serverFunctions/agency-ops";

type KindFilter = "all" | "alert-cycle" | "monthly-report" | "digest";

const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "alert-cycle", label: "Alerts" },
  { id: "monthly-report", label: "Reports" },
  { id: "digest", label: "Digests" },
];

function kindPill(kind: string) {
  const tone =
    kind === "alert-cycle"
      ? "badge-error"
      : kind === "monthly-report"
        ? "badge-primary"
        : "badge-ghost";
  const label =
    kind === "alert-cycle"
      ? "alert"
      : kind === "monthly-report"
        ? "report"
        : kind === "digest"
          ? "digest"
          : kind;
  return <span className={`badge badge-sm ${tone}`}>{label}</span>;
}

function severityPill(severity: string) {
  const normalized = severity.toLowerCase();
  const tone =
    normalized === "high" || normalized === "critical"
      ? "badge-error"
      : normalized === "medium" || normalized === "warning"
        ? "badge-warning"
        : "badge-ghost";
  return <span className={`badge badge-sm ${tone}`}>{severity}</span>;
}

function AlertCycleDetail({ content }: { content: string }) {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return (
        <p className="text-sm text-error">
          Could not parse alert-cycle JSON — raw content is invalid.
        </p>
      );
    }

    const record = parsed as Record<string, unknown>;
    const alerts = Array.isArray(record.alerts) ? record.alerts : [];
    const bySeverity = new Map<string, Array<Record<string, unknown>>>();

    for (const entry of alerts) {
      if (!entry || typeof entry !== "object") continue;
      const alert = entry as Record<string, unknown>;
      const severity =
        typeof alert.severity === "string" ? alert.severity : "unknown";
      const group = bySeverity.get(severity) ?? [];
      group.push(alert);
      bySeverity.set(severity, group);
    }

    if (bySeverity.size === 0) {
      return (
        <p className="text-sm text-base-content/55">
          No alerts in this cycle.
        </p>
      );
    }

    return (
      <div className="space-y-4">
        {Array.from(bySeverity.entries()).map(([severity, group]) => (
          <div key={severity} className="space-y-2">
            <div>{severityPill(severity)}</div>
            <ul className="space-y-2">
              {group.map((alert, index) => (
                <li
                  key={`${severity}-${index}`}
                  className="text-sm text-base-content/85"
                >
                  <span className="font-semibold">
                    {typeof alert.domain === "string" ? alert.domain : "—"}
                  </span>
                  {" — "}
                  {typeof alert.message === "string" ? alert.message : "—"}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  } catch {
    return (
      <p className="text-sm text-error">
        Could not parse alert-cycle JSON — check the stored artifact.
      </p>
    );
  }
}

function ArtifactDetail({
  artifact,
}: {
  artifact: NonNullable<Awaited<ReturnType<typeof getOpsArtifact>>>;
}) {
  return (
    <article className="space-y-3 rounded-xl bg-base-100 p-4 ring-1 ring-base-300/60">
      <div className="flex flex-wrap items-center gap-2">
        {kindPill(artifact.kind)}
        <span className="text-sm text-base-content/55">
          {artifact.domain ?? "fleet"} · {artifact.date}
        </span>
        <span className="text-xs text-base-content/45">
          Received {formatRelativeFinishedAt(artifact.receivedAt)}
        </span>
      </div>

      {artifact.contentType === "markdown" ? (
        <Markdown className="text-sm leading-relaxed text-base-content/85">
          {artifact.content}
        </Markdown>
      ) : artifact.contentType === "html" ? (
        <iframe
          sandbox=""
          srcDoc={artifact.content}
          title="report"
          className="h-[70vh] w-full rounded-xl ring-1 ring-base-300/60"
        />
      ) : artifact.kind === "alert-cycle" ? (
        <AlertCycleDetail content={artifact.content} />
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-base-content/85">
          {artifact.content}
        </pre>
      )}
    </article>
  );
}

export function AgencyOpsPage() {
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["agency-ops-artifacts", kindFilter],
    queryFn: () =>
      listOpsArtifacts({
        data: {
          kind: kindFilter === "all" ? undefined : kindFilter,
          limit: 50,
        },
      }),
  });

  const detailQuery = useQuery({
    queryKey: ["agency-ops-artifact", selectedId],
    queryFn: () => getOpsArtifact({ data: { id: selectedId! } }),
    enabled: Boolean(selectedId),
  });

  const artifacts = listQuery.data ?? [];

  return (
    <div className="h-full overflow-auto bg-base-100">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 md:px-6 md:py-10">
        <header className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-base-content/45">
            Operations
          </p>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
            Ops artifacts
          </h1>
          <p className="max-w-2xl text-sm text-base-content/55">
            Alert cycles, monthly reports, and digests pushed from the Hermes ops
            box.
          </p>
        </header>

        <div className="flex flex-col gap-6 lg:flex-row">
          <section className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap gap-2">
              {KIND_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => {
                    setKindFilter(filter.id);
                    setSelectedId(null);
                  }}
                  className={`btn btn-sm ${
                    kindFilter === filter.id ? "btn-primary" : "btn-ghost"
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>

            {listQuery.isLoading ? (
              <div className="flex justify-center py-12">
                <span className="loading loading-spinner loading-md" />
              </div>
            ) : listQuery.isError ? (
              <p className="rounded-xl border border-dashed border-error/50 bg-error/5 px-4 py-8 text-center text-sm text-error">
                Could not load artifacts — try reloading the page.
              </p>
            ) : artifacts.length === 0 ? (
              <p className="rounded-xl border border-dashed border-base-300/80 bg-base-200/30 px-4 py-8 text-center text-sm text-base-content/55">
                No artifacts received yet.
              </p>
            ) : (
              <ul className="divide-y divide-base-300/60 rounded-xl ring-1 ring-base-300/60">
                {artifacts.map((artifact) => (
                  <li key={artifact.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(artifact.id)}
                      className={`flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left transition hover:bg-base-200/40 ${
                        selectedId === artifact.id ? "bg-base-200/60" : ""
                      }`}
                    >
                      {kindPill(artifact.kind)}
                      <span className="text-sm font-medium">
                        {artifact.domain ?? "fleet"}
                      </span>
                      <span className="text-xs text-base-content/50">
                        {artifact.date}
                      </span>
                      <span className="ml-auto text-xs text-base-content/45">
                        {formatRelativeFinishedAt(artifact.receivedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="min-w-0 flex-1">
            {selectedId && detailQuery.isLoading ? (
              <div className="flex justify-center py-12">
                <span className="loading loading-spinner loading-md" />
              </div>
            ) : selectedId && detailQuery.isError ? (
              <p className="rounded-xl border border-dashed border-error/50 bg-error/5 px-4 py-8 text-center text-sm text-error">
                Could not load this artifact — try again.
              </p>
            ) : selectedId && detailQuery.data ? (
              <ArtifactDetail artifact={detailQuery.data} />
            ) : selectedId && detailQuery.isSuccess ? (
              <p className="rounded-xl border border-dashed border-base-300/80 bg-base-200/30 px-4 py-8 text-center text-sm text-base-content/55">
                This artifact no longer exists.
              </p>
            ) : (
              <p className="rounded-xl border border-dashed border-base-300/80 bg-base-200/30 px-4 py-8 text-center text-sm text-base-content/55">
                Select an artifact to view its contents.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
