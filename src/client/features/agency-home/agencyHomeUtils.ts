import type { AgencyHomePortfolioRow } from "@/server/features/agency/AgencyHomeService";
import type { AgencyHomePillTone } from "@/client/features/agency-home/AgencyHomeStatusPill";

/** Stable hue for letter-tile avatars when favicon is unavailable. */
export function hashDomainLabel(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function domainLetterTile(
  domain: string | null | undefined,
  projectName: string,
): { letter: string; hue: number } {
  const source = (domain?.trim() || projectName.trim() || "?");
  const letter = source.charAt(0).toUpperCase();
  return { letter, hue: hashDomainLabel(source.toLowerCase()) % 360 };
}

export type PortfolioRowStatus = { label: string; tone: AgencyHomePillTone };

/** Status pill derived only from portfolio row fields + optional running-mission flag. */
export function portfolioRowStatus(
  row: AgencyHomePortfolioRow,
  hasRunningMission: boolean,
): PortfolioRowStatus {
  if (hasRunningMission) {
    return { label: "Running", tone: "warning" };
  }
  if (!row.gscConnected) {
    return { label: "Connect GSC", tone: "muted" };
  }
  if (row.gscClicks28d != null) {
    return { label: "Live", tone: "success" };
  }
  return { label: "Connected", tone: "info" };
}

/** Relative time for mission rail timestamps (real ISO strings only). */
export function formatRelativeFinishedAt(iso: string | null | undefined): string {
  if (!iso) return "in progress";
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "—";

  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 0) return "just now";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

export function projectFaviconUrl(domain: string | null | undefined): string | null {
  if (!domain?.trim()) return null;
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  if (!host) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
}

/** sessionStorage key for Ask-Sam prefill (read by SamConversation). */
export function samAskStorageKey(projectId: string): string {
  return `sam-loops-ask:${projectId}`;
}

/** sessionStorage key so Sam Loops can open with a run selected. */
export function samLoopRunStorageKey(projectId: string): string {
  return `sam-loops-select-run:${projectId}`;
}

export function storeSamAskDraft(projectId: string, draft: string): void {
  try {
    sessionStorage.setItem(samAskStorageKey(projectId), draft.trim());
  } catch {
    // Private mode / quota — navigation still works without prefill.
  }
}

export function storeSamLoopRunSelection(projectId: string, runId: string): void {
  try {
    sessionStorage.setItem(samLoopRunStorageKey(projectId), runId);
  } catch {
    // ignore
  }
}
