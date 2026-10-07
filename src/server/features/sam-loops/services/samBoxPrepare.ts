import type { ToolSet } from "ai";
import { z } from "zod";
import { withPgClient } from "@/db";
import { MCP_SCOPE } from "@/lib/oauth-resource";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { ProjectContextService } from "@/server/features/project-context/services/ProjectContextService";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { buildSamMcpTools } from "@/server/features/sam/samChatTools";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import type { ToolAuthContext } from "@/server/mcp/context";
import { selfHostBaseUrl } from "@/server/workflows/selfHostBaseUrl";
import {
  isSamLoopProjectAllowed,
  SAM_LOOP_ALLOWED_DOMAINS,
} from "@/shared/sam-loops";
import { checkAuditReadiness } from "./loopFreshness";
import { buildScopedLoopTools } from "./loopToolFilter";
import { onPageExecutionPrompt } from "./onPageExecutionPrompt";
import { generationErrorDetail } from "./runHeadlessSamLoop";
import {
  boxFailed,
  boxRecord,
  renderSamBoxPrompt,
  type SamBoxDataBlock,
} from "./samBoxPrepareRender";
import type { SamBoxPrepareInput, SamBoxPrepared } from "./samBoxTypes";

export { truncateJsonToBytes } from "./samBoxPrepareRender";

type PrepareDeps = {
  buildTools: (
    authContext: ToolAuthContext,
    project: { id: string; domain: string | null },
    scope: {
      sourceType: string;
      customPrompt: string | null;
      loopName: string;
    },
  ) => ToolSet;
  now: () => number;
};

const defaultDeps: PrepareDeps = {
  buildTools: (authContext, project, scope) =>
    buildScopedLoopTools(buildSamMcpTools(authContext, project), scope),
  now: () => Date.now(),
};

const ctrRow = z.object({
  keys: z.tuple([z.string(), z.string()]),
  clicks: z.number().nonnegative(),
  impressions: z.number().nonnegative(),
  ctr: z.number().min(0).max(1),
  position: z.number(),
});

export function deriveCtrCandidates(
  rows: readonly unknown[],
  meta: { pagesFetched: number; hasMoreUnread: boolean },
) {
  const candidates = rows.flatMap((row) => {
    const parsed = ctrRow.safeParse(row);
    if (!parsed.success) return [];
    const {
      keys: [query, page],
      clicks,
      impressions,
      ctr,
      position,
    } = parsed.data;
    return position >= 5 && position <= 20 && impressions >= 30 && ctr <= 0.01
      ? [{ query, page, position, impressions, ctr, clicks }]
      : [];
  });
  const compare = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;
  candidates.sort(
    (a, b) =>
      b.impressions - a.impressions ||
      compare(a.query, b.query) ||
      compare(a.page, b.page),
  );
  return {
    rowsScanned: rows.length,
    pagesFetched: meta.pagesFetched,
    hasMoreUnread: meta.hasMoreUnread,
    candidates: candidates.slice(0, 10),
  };
}

function toolData(value: unknown): Record<string, unknown> {
  const output = boxRecord(value);
  return boxRecord(output?.data) ?? output ?? {};
}

function pick(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const record = boxRecord(value) ?? {};
  return Object.fromEntries(
    fields
      .filter((field) => field in record)
      .map((field) => [field, record[field]]),
  );
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizedPage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function ctrPageInputs(
  value: unknown,
  candidates: ReturnType<typeof deriveCtrCandidates>["candidates"],
): unknown {
  const data = toolData(value);
  const urls = new Set(
    candidates.flatMap((candidate) => {
      const url = normalizedPage(candidate.page);
      return url ? [url] : [];
    }),
  );
  const homepage = boxRecord(data.homepage);
  const homeUrl = normalizedPage(homepage?.url);
  const fields = [
    "url",
    "path",
    "title",
    "titleLength",
    "description",
    "descriptionLength",
    "h1Count",
    "checksFlagged",
  ];
  const pages = array(data.pages)
    .filter((page) => {
      const url = normalizedPage(boxRecord(page)?.url);
      return url !== null && (urls.has(url) || url === homeUrl);
    })
    .map((page) => pick(page, fields));
  return { ...data, homepage: homepage ? pick(homepage, fields) : null, pages };
}

function gscFailure(block: SamBoxDataBlock): SamBoxPrepared {
  const data = toolData(block.value);
  if (
    ["not_connected", "gsc_oauth_not_configured"].includes(String(data.reason))
  ) {
    return {
      kind: "final",
      status: "completed",
      error: null,
      report:
        "Not measured — Search Console is not connected for this project. No model call was made.",
    };
  }
  // Tool reasons are normally enum-like codes. Free-form failures still use
  // the existing error redactor before they can become stored run text.
  const reason =
    typeof data.reason === "string" && /^[a-z_]{1,64}$/.test(data.reason)
      ? data.reason
      : generationErrorDetail(data.error ?? new Error("Reader unavailable"));
  return boxFailed(`Search Console read failed: ${reason}`);
}

/** Read-only prepare: the claim service owns all run/cadence writes. */
export async function prepareSamBoxClaim(
  input: SamBoxPrepareInput,
  deps?: Partial<PrepareDeps>,
): Promise<SamBoxPrepared> {
  try {
    return await prepare(input, { ...defaultDeps, ...deps });
  } catch {
    // Unexpected repository/build/serialization exceptions may contain input
    // or provider text. The caller gets only this short, safe message.
    throw new Error("Box prepare inputs unavailable.");
  }
}

async function prepare(
  input: SamBoxPrepareInput,
  deps: PrepareDeps,
): Promise<SamBoxPrepared> {
  const startedAt = deps.now();
  const deadline = startedAt + 60000;
  const project = await withPgClient(() =>
    ProjectRepository.getProjectById(input.loop.projectId),
  );
  if (
    !project ||
    project.archivedAt !== null ||
    !isSamLoopProjectAllowed(project)
  ) {
    return boxFailed(
      "Loop is not enabled for this project.",
      `Loop not enabled for this domain (${project?.domain ?? "no domain"}). Allowed: the house domains or a project Jon enabled for loops (${SAM_LOOP_ALLOWED_DOMAINS.join(", ")}). No tools were called.`,
    );
  }
  const domain = project.domain;
  if (!domain || !input.loop.customPrompt)
    throw new Error("Box loop inputs unavailable.");
  let crawlEvidence: string | null = null;
  let staleNotice = "";
  if (input.kind === "on_page_priorities") {
    let readiness: ReturnType<typeof checkAuditReadiness>;
    try {
      const audit = await withPgClient(() =>
        AuditRepository.getLatestAuditForProject(project.id),
      );
      const pages = audit
        ? await withPgClient(() => AuditRepository.getPagesForAudit(audit.id))
        : [];
      readiness = checkAuditReadiness(
        audit,
        pages,
        domain,
        new Date(deps.now()),
        {
          allowStale:
            (await getOptionalEnvValue("SAM_LOOP_ALLOW_STALE_AUDIT")) ===
            "true",
        },
      );
    } catch {
      readiness = {
        ready: false,
        reason: "The saved crawl could not be read.",
      };
    }
    if (!readiness.ready) {
      return boxFailed(
        `Current crawl input unavailable: ${readiness.reason}`,
        `Current crawl input unavailable: ${readiness.reason} Refresh and verify the site crawl before trying again. No model or research tools were called.`,
      );
    }
    crawlEvidence = `Crawl input checked before this run: measured ${readiness.measuredAt}; ${readiness.usablePages} usable own-site pages. This proves usable crawl input only, not complete site coverage or site health. Read the same current audit through the tools before drawing conclusions.`;
    if (readiness.stale) {
      staleNotice = `STALE AUDIT — measured ${readiness.measuredAt}; age ${readiness.stale.ageDays.toFixed(1)} days. Historical evidence only; current page state is not verified.\n\n`;
      crawlEvidence = staleNotice + crawlEvidence;
    }
  }
  const authContext: ToolAuthContext = {
    userId: "system",
    userEmail: "system@openseo.so",
    organizationId: input.loop.organizationId,
    clientId: null,
    baseUrl: selfHostBaseUrl(input.env),
    scopes: [MCP_SCOPE],
  };
  const tools = deps.buildTools(
    authContext,
    { id: project.id, domain },
    {
      sourceType: "custom",
      customPrompt: input.loop.customPrompt,
      loopName: input.loop.name,
    },
  );
  let callNumber = 0;
  const read = async (
    name: string,
    args: Record<string, unknown>,
    cap: number,
  ): Promise<SamBoxDataBlock> => {
    const base = { name, args, cap, derived: null };
    const failed = (error: string): SamBoxDataBlock => ({
      ...base,
      ok: false,
      value: { ok: false, error },
    });
    const remaining = deadline - deps.now();
    if (remaining <= 0) return failed("prepare budget exhausted");
    const execute = tools[name]?.execute;
    if (!execute) return failed("Reader unavailable");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutMessage: string | null = null;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            timeoutMessage =
              remaining < 20000
                ? "prepare budget exhausted"
                : "Tool timed out after 20 seconds.";
            reject(new Error(timeoutMessage));
          },
          Math.min(20000, remaining),
        );
      });
      const output: unknown = await Promise.race([
        withPgClient(async () =>
          execute(args, {
            toolCallId: `box-prefetch-${++callNumber}`,
            messages: [],
          }),
        ),
        timeout,
      ]);
      const envelope = boxRecord(output);
      if (!envelope) return failed("Reader returned invalid data.");
      const data = boxRecord(envelope.data);
      const ok = !(
        envelope.error ||
        envelope.isError ||
        envelope.ok === false ||
        data?.error ||
        data?.isError ||
        data?.ok === false
      );
      return { ...base, ok, value: output };
    } catch (error) {
      return failed(timeoutMessage ?? generationErrorDetail(error));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const blocks: SamBoxDataBlock[] = [];
  if (input.kind === "on_page_priorities") {
    blocks.push(await read("get_niceseo_ops_status", { domain }, 1000));
    blocks.push(await read("get_audit_status", {}, 1000));
    const issues = await read("get_audit_issues", {}, 3500);
    if (issues.ok) {
      const data = toolData(issues.value);
      issues.value = {
        summary: array(data.summary),
        issues: array(data.issues).slice(0, 30),
      };
    }
    blocks.push(issues);
    blocks.push(await read("get_audit_pages", { limit: 25 }, 2500));
    blocks.push(
      await read("get_agency_otto_page_inputs", { domain, limit: 25 }, 4000),
    );
    const gsc = await read(
      "get_search_console_performance",
      { dimensions: ["page"], dateRange: "last_28_days", rowLimit: 50 },
      2000,
    );
    if (gsc.ok) {
      const data = toolData(gsc.value);
      gsc.value = {
        ...data,
        rows: array(data.rows)
          .slice(0, 15)
          .map((row) =>
            pick(row, ["keys", "clicks", "impressions", "ctr", "position"]),
          ),
      };
    }
    blocks.push(gsc);
    const pendingArgs = { domain, status: "pending", limit: 50 };
    const pulledArgs = { domain, status: "pulled", limit: 50 };
    const pending = await read(
      "list_homegrown_otto_proposals",
      pendingArgs,
      1500,
    );
    const pulled = await read(
      "list_homegrown_otto_proposals",
      pulledArgs,
      1500,
    );
    const failures = [pending, pulled].filter((block) => !block.ok);
    blocks.push({
      name: "list_homegrown_otto_proposals",
      args: { pending: pendingArgs, pulled: pulledArgs },
      ok: failures.length === 0,
      derived: null,
      cap: 1500,
      value: {
        proposals: [pending, pulled]
          .filter((block) => block.ok)
          .flatMap((block) => array(toolData(block.value).proposals))
          .map((proposal) => pick(proposal, ["id", "path", "status", "fixes"])),
        ...(failures.length
          ? {
              errors: failures.map((block) => ({
                status: block.args.status,
                ...toolData(block.value),
              })),
            }
          : {}),
      },
    });
  } else {
    const args = {
      dimensions: ["query", "page"],
      dateRange: "last_28_days",
      rowLimit: 1000,
    };
    const rows: unknown[] = [];
    let pagesFetched = 0;
    let hasMoreUnread = false;
    for (let page = 0; page < 3; page++) {
      const gsc = await read(
        "get_search_console_performance",
        { ...args, ...(page ? { startRow: page * 1000 } : {}) },
        4000,
      );
      if (!gsc.ok) {
        const failure = gscFailure(gsc);
        // A partial scan cannot prove zero qualifying queries. A later page
        // failure is failed even when it reports a connection has disappeared.
        return page &&
          failure.kind === "final" &&
          failure.status === "completed"
          ? boxFailed("Search Console read failed: incomplete_scan")
          : failure;
      }
      const data = toolData(gsc.value);
      if (!Array.isArray(data.rows))
        return boxFailed("Search Console read failed: invalid_response");
      rows.push(...data.rows);
      pagesFetched++;
      hasMoreUnread = page === 2 && data.hasMore === true;
      if (data.hasMore !== true) break;
    }
    const candidates = deriveCtrCandidates(rows, {
      pagesFetched,
      hasMoreUnread,
    });
    if (!candidates.candidates.length) {
      return {
        kind: "final",
        status: "completed",
        error: null,
        report: `No query met the thresholds (position 5-20, impressions at least 30, CTR 1% or lower) in the last 28 days. ${candidates.rowsScanned} rows scanned. No model call was made.${hasMoreUnread ? " Not every row was read: more rows exist." : ""}`,
      };
    }
    blocks.push({
      name: "get_search_console_performance",
      args,
      ok: true,
      derived: "ctr_candidates_v1",
      cap: 4000,
      value: candidates,
    });
    const pages = await read(
      "get_agency_otto_page_inputs",
      { domain, limit: 100 },
      6000,
    );
    if (pages.ok)
      pages.value = ctrPageInputs(pages.value, candidates.candidates);
    blocks.push(pages);
  }
  const context = await withPgClient(() =>
    ProjectContextService.getProjectContext(project.id),
  );
  return renderSamBoxPrompt({
    kind: input.kind,
    loopName: input.loop.name,
    project,
    runDate: new Date(startedAt).toISOString().slice(0, 10),
    contextMarkdown:
      ProjectContextService.renderProjectContextMarkdown(context),
    executionPrompt:
      input.kind === "on_page_priorities"
        ? onPageExecutionPrompt(input.loop.customPrompt)
        : input.loop.customPrompt,
    crawlEvidence,
    staleNotice,
    blocks,
    maxPromptBytes: input.maxPromptBytes,
  });
}
