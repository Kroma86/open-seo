/** Additive scheduling holds. Expiry never changes activity, consent or cadence.
 * NIC-859: preserve the existing local pause window, including its early start
 * before overnight jobs. UTC instants match the existing explicit -07:00 dates.
 * These rules select no work and call no providers; they only exclude due rows.
 */
const SCHEDULED_SEO_PAUSES = [
  {
    projectId: "d6d3c442-bedf-4c4c-b65b-17d0fcf4ec4d",
    start: "2026-10-01T05:50:00.000Z",
    end: "2026-12-01T07:00:00.000Z",
  },
] as const;

export function pausedScheduledSeoProjects(nowIso: string): string[] {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now) || new Date(now).toISOString() !== nowIso) {
    throw new Error(
      "Scheduled SEO pause check requires a canonical UTC instant",
    );
  }
  return SCHEDULED_SEO_PAUSES.filter((pause) => {
    const start = Date.parse(pause.start);
    const end = Date.parse(pause.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new Error("Invalid scheduled SEO pause window");
    }
    return start <= now && now < end;
  }).map((pause) => pause.projectId);
}
