import { Link } from "@tanstack/react-router";
import type { AgencyHomeMission } from "@/server/features/agency/AgencyHomeService";
import {
  formatRelativeFinishedAt,
  storeSamLoopRunSelection,
} from "@/client/features/agency-home/agencyHomeUtils";
import { AgencyHomeHorizontalScroll } from "@/client/features/agency-home/AgencyHomeHorizontalScroll";
import {
  AgencyHomeStatusPill,
  type AgencyHomePillTone,
} from "@/client/features/agency-home/AgencyHomeStatusPill";

function missionStatusTone(status: AgencyHomeMission["status"]): AgencyHomePillTone {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  return "warning";
}

export function AgencyHomeMissionsRail({
  missions,
  isLoading,
}: {
  missions: AgencyHomeMission[];
  isLoading: boolean;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Missions</h2>
        <p className="text-xs text-base-content/45">Recent Sam Loop runs</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center rounded-xl border border-base-300/70 bg-base-100 py-8">
          <span className="loading loading-spinner loading-md" />
        </div>
      ) : missions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-base-300/80 bg-base-200/30 px-4 py-8 text-center text-sm text-base-content/55">
          No missions yet. Enable a loop or ask Sam — runs land here.
        </p>
      ) : (
        <AgencyHomeHorizontalScroll fadeFromClass="from-base-100">
          {missions.map((mission) => (
            <Link
              key={mission.id}
              to="/p/$projectId/loops"
              params={{ projectId: mission.projectId }}
              onClick={() =>
                storeSamLoopRunSelection(mission.projectId, mission.id)
              }
              className="min-w-[220px] max-w-[280px] shrink-0 rounded-xl border border-base-300/60 bg-base-100 px-4 py-3 text-left transition hover:border-primary/35 hover:bg-base-200/35 hover:shadow-sm"
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  {mission.loopName}
                </span>
                <AgencyHomeStatusPill
                  label={mission.status}
                  tone={missionStatusTone(mission.status)}
                />
              </div>
              <p className="truncate text-xs text-base-content/50">
                {mission.projectDomain ?? mission.projectName}
              </p>
              <p className="mt-1 text-xs text-base-content/45">
                {mission.status === "running" && !mission.finishedAt
                  ? "in progress"
                  : formatRelativeFinishedAt(
                      mission.finishedAt ??
                        mission.startedAt ??
                        mission.createdAt,
                    )}
              </p>
              {mission.costNote ? (
                <p className="mt-1.5 truncate text-xs text-base-content/55">
                  {mission.costNote}
                </p>
              ) : null}
            </Link>
          ))}
        </AgencyHomeHorizontalScroll>
      )}
    </section>
  );
}
