/**
 * Read-only, free portfolio AI-visibility sweep.
 *
 * Turns existing read results (list_projects → tracking config list →
 * get_ai_visibility_trend) into one structured row per project — the durable
 * 38-row portfolio artifact. This module never triggers a measurement: the
 * injected source exposes ONLY the three read paths, so no paid call is
 * reachable from here by construction.
 *
 * Semantics enforced here (do not relax them downstream):
 * - `totalMentions` is a raw count, never a named-in rate.
 * - `shareOfVoicePct: null` means "not measured" — never zero-filled. A
 *   measured 0 stays 0.
 * - A completed run with zero checked prompts is an empty pass, not a usable
 *   baseline (`status: "empty_pass"`, `namedInRate: null`).
 * - A changed prompt-set version resets comparisons (`promptSetChanged`).
 * - External/Hermes observations are out of scope by construction: the source
 *   contract carries native OpenSEO reads only, so the two sources can never
 *   be summed into one total here.
 *
 * Pure transforms + dependency injection: tests run with fixtures, no
 * credentials, no network. The db-backed wiring lives in
 * portfolioVisibilitySweepSource.ts; exposing it (endpoint, MCP tool, or
 * Hermes job) is a runtime-operator decision, not part of this module.
 */
import type {
  AiVisibilityLatestResults,
  AiVisibilityRunStatus,
} from "@/types/schemas/ai-visibility";

// ---------------------------------------------------------------------------
// Source contract — mirrors the three read-only calls, nothing else.
// ---------------------------------------------------------------------------

export type PortfolioSweepProject = {
  id: string;
  name: string;
  domain: string | null;
  /**
   * SAM repair loops enabled for this project (projects.loopsEnabled).
   * null when the read source does not expose it (e.g. the list_projects
   * MCP payload) — "unknown", never assumed on or off.
   */
  repairLoopEnabled?: boolean | null;
};

export type PortfolioTrackingConfig = {
  id: string;
  brand: string;
  isActive: boolean;
  scheduleInterval: "weekly" | "monthly" | "manual";
  promptSetVersion: number;
  createdAt: string | null;
  prompts: Array<{ id: string; isActive: boolean }>;
};

/**
 * The three read-only portfolio calls. Implementations must use stored data
 * only — never a "run measurement" endpoint.
 */
export interface PortfolioVisibilitySource {
  listProjects(): Promise<PortfolioSweepProject[]>;
  listTrackingConfigs(
    projectId: string,
  ): Promise<PortfolioTrackingConfig[]>;
  /**
   * The `latest` block of get_ai_visibility_trend's structured content
   * (native OpenSEO runs only — externalObservations are not part of this
   * contract and must not be merged in).
   */
  getAiVisibilityTrend(
    projectId: string,
    configId: string,
  ): Promise<AiVisibilityLatestResults>;
}

// ---------------------------------------------------------------------------
// Artifact schema.
// ---------------------------------------------------------------------------

export const PORTFOLIO_SWEEP_ERROR_CODES = [
  "PROJECTS_READ_FAILED",
  "CONFIGS_READ_FAILED",
  "TREND_READ_FAILED",
  "NO_TRACKING_CONFIG",
] as const;

export type PortfolioSweepErrorCode =
  (typeof PORTFOLIO_SWEEP_ERROR_CODES)[number];

export type PortfolioSweepError = {
  code: PortfolioSweepErrorCode;
  message: string;
};

export class PortfolioVisibilitySweepError extends Error {
  readonly code: PortfolioSweepErrorCode;
  constructor(code: PortfolioSweepErrorCode, message: string) {
    super(message);
    this.name = "PortfolioVisibilitySweepError";
    this.code = code;
  }
}

export const PORTFOLIO_ROW_STATUSES = [
  // Measured and usable as a baseline.
  "ok",
  // Latest run completed but checked zero prompts — not a usable baseline.
  "empty_pass",
  // Config exists but no completed run yet.
  "never_measured",
  // Project has no tracking config.
  "no_config",
  // A read failed; see error.code.
  "unreadable",
] as const;

export type PortfolioRowStatus = (typeof PORTFOLIO_ROW_STATUSES)[number];

export type PortfolioRowFreshness = "fresh" | "stale" | "unscheduled" | null;

export type PortfolioVisibilityRow = {
  domain: string | null;
  projectId: string;
  projectName: string;
  /** Selected config (active configs win; see selectConfig). */
  configId: string | null;
  brand: string | null;
  /** The config's current prompt-set version (from the trend read). */
  promptSetVersion: number | null;
  activePromptCount: number;
  latestRunId: string | null;
  latestCompletedAt: string | null;
  latestRunStatus: AiVisibilityRunStatus | null;
  /** Prompt-set version the latest run was measured against. */
  latestRunPromptSetVersion: number | null;
  /** True when the run's version differs from the config's — comparisons reset. */
  promptSetChanged: boolean;
  promptsWithBrand: number | null;
  promptsChecked: number | null;
  /**
   * promptsWithBrand / promptsChecked (0–1, 4 dp). null when not computable
   * (no run, or zero checked prompts). A measured 0 stays 0.
   */
  namedInRate: number | null;
  /** Raw mention count — NOT a rate; never mix with namedInRate. */
  totalMentions: number | null;
  /** null means "not measured", never zero. */
  shareOfVoicePct: number | null;
  /** SAM repair loops enabled; null = unknown (source did not expose it). */
  repairLoopEnabled: boolean | null;
  status: PortfolioRowStatus;
  freshness: PortfolioRowFreshness;
  error: PortfolioSweepError | null;
  generatedAt: string;
};

export type PortfolioVisibilitySnapshot = {
  generatedAt: string;
  rowCount: number;
  rows: PortfolioVisibilityRow[];
};

// ---------------------------------------------------------------------------
// Classification (pure).
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 31 * 24 * 60 * 60 * 1000;
/** Grace multiplier on the configured interval before a run is stale. */
export const PORTFOLIO_SWEEP_STALE_GRACE = 1.25;

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.trim().slice(0, 300) || "Unknown read error";
}

/** Deterministic: active configs first, then oldest created, then id. */
export function selectConfig(
  configs: PortfolioTrackingConfig[],
): PortfolioTrackingConfig | null {
  if (configs.length === 0) return null;
  const ranked = configs.toSorted((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const at = a.createdAt ?? "";
    const bt = b.createdAt ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ranked[0] ?? null;
}

export function namedInRate(
  promptsWithBrand: number | null,
  promptsChecked: number | null,
): number | null {
  if (promptsWithBrand == null || promptsChecked == null) return null;
  if (promptsChecked <= 0) return null;
  return Math.round((promptsWithBrand / promptsChecked) * 10000) / 10000;
}

export function classifyFreshness(input: {
  scheduleInterval: "weekly" | "monthly" | "manual";
  latestCompletedAt: string | null;
  now: Date;
}): PortfolioRowFreshness {
  if (!input.latestCompletedAt) return null;
  if (input.scheduleInterval === "manual") return "unscheduled";
  const finishedMs = new Date(input.latestCompletedAt).getTime();
  if (!Number.isFinite(finishedMs)) return null;
  const budget =
    (input.scheduleInterval === "weekly" ? WEEK_MS : MONTH_MS) *
    PORTFOLIO_SWEEP_STALE_GRACE;
  return input.now.getTime() - finishedMs <= budget ? "fresh" : "stale";
}

function baseRow(
  project: PortfolioSweepProject,
  generatedAt: string,
): PortfolioVisibilityRow {
  return {
    domain: project.domain,
    projectId: project.id,
    projectName: project.name,
    configId: null,
    brand: null,
    promptSetVersion: null,
    activePromptCount: 0,
    latestRunId: null,
    latestCompletedAt: null,
    latestRunStatus: null,
    latestRunPromptSetVersion: null,
    promptSetChanged: false,
    promptsWithBrand: null,
    promptsChecked: null,
    namedInRate: null,
    totalMentions: null,
    shareOfVoicePct: null,
    repairLoopEnabled: project.repairLoopEnabled ?? null,
    status: "unreadable",
    freshness: null,
    error: null,
    generatedAt,
  };
}

/** Build one project's row from its reads. Pure once the reads are given. */
export function buildPortfolioVisibilityRow(input: {
  project: PortfolioSweepProject;
  config: PortfolioTrackingConfig;
  latest: AiVisibilityLatestResults;
  now: Date;
  generatedAt: string;
}): PortfolioVisibilityRow {
  const { project, config, latest, now, generatedAt } = input;
  const row = baseRow(project, generatedAt);
  row.configId = config.id;
  row.brand = config.brand;
  row.activePromptCount = config.prompts.filter((p) => p.isActive).length;

  const run = latest.latestRun;
  if (!latest.measured || !run) {
    row.promptSetVersion =
      latest.config?.promptSetVersion ?? config.promptSetVersion;
    row.status = "never_measured";
    return row;
  }

  // The trend payload's config block is read atomically with the run — its
  // version is the internally consistent reference for the reset comparison.
  row.promptSetVersion =
    latest.config?.promptSetVersion ?? config.promptSetVersion;
  row.latestRunId = run.id;
  row.latestCompletedAt = run.finishedAt ?? latest.fetchedAt;
  row.latestRunStatus = run.status;
  row.latestRunPromptSetVersion = run.promptSetVersion;
  row.promptSetChanged = run.promptSetVersion !== row.promptSetVersion;
  row.promptsWithBrand = run.promptsWithBrand;
  row.promptsChecked = run.promptsChecked;
  row.namedInRate = namedInRate(run.promptsWithBrand, run.promptsChecked);
  row.totalMentions = run.totalMentions;
  // Passthrough: null stays null ("not measured"), a measured 0 stays 0.
  row.shareOfVoicePct = run.shareOfVoicePct;
  row.status = run.promptsChecked === 0 ? "empty_pass" : "ok";
  row.freshness = classifyFreshness({
    scheduleInterval: config.scheduleInterval,
    latestCompletedAt: row.latestCompletedAt,
    now,
  });
  return row;
}

async function buildProjectRow(
  source: PortfolioVisibilitySource,
  project: PortfolioSweepProject,
  now: Date,
  generatedAt: string,
): Promise<PortfolioVisibilityRow> {
  const row = baseRow(project, generatedAt);

  let configs: PortfolioTrackingConfig[];
  try {
    configs = await source.listTrackingConfigs(project.id);
  } catch (error) {
    row.status = "unreadable";
    row.error = { code: "CONFIGS_READ_FAILED", message: errorMessage(error) };
    return row;
  }

  const config = selectConfig(configs);
  if (!config) {
    row.status = "no_config";
    row.error = {
      code: "NO_TRACKING_CONFIG",
      message: "Project has no AI visibility tracking config.",
    };
    return row;
  }
  row.configId = config.id;
  row.brand = config.brand;
  row.activePromptCount = config.prompts.filter((p) => p.isActive).length;

  let latest: AiVisibilityLatestResults;
  try {
    latest = await source.getAiVisibilityTrend(project.id, config.id);
  } catch (error) {
    row.promptSetVersion = config.promptSetVersion;
    row.status = "unreadable";
    row.error = { code: "TREND_READ_FAILED", message: errorMessage(error) };
    return row;
  }

  return buildPortfolioVisibilityRow({
    project,
    config,
    latest,
    now,
    generatedAt,
  });
}

/**
 * Sweep every project into one row each. A list_projects failure throws
 * (typed) so the caller keeps the previous good artifact instead of
 * overwriting it with an empty one; per-project failures degrade to
 * unreadable rows and never abort the sweep.
 */
export async function buildPortfolioVisibilitySnapshot(
  source: PortfolioVisibilitySource,
  options: { now?: Date } = {},
): Promise<PortfolioVisibilitySnapshot> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();

  let projects: PortfolioSweepProject[];
  try {
    projects = await source.listProjects();
  } catch (error) {
    throw new PortfolioVisibilitySweepError(
      "PROJECTS_READ_FAILED",
      errorMessage(error),
    );
  }

  const rows: PortfolioVisibilityRow[] = [];
  for (const project of projects) {
    rows.push(await buildProjectRow(source, project, now, generatedAt));
  }
  return { generatedAt, rowCount: rows.length, rows };
}
