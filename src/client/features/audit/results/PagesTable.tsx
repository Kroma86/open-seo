import { useMemo, useState } from "react";
import {
  createColumnHelper,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ChevronDown, Columns3, ExternalLink } from "lucide-react";
import {
  AppDataTable,
  useAppTable,
} from "@/client/components/table/AppDataTable";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import {
  extractHostname,
  extractPathname,
  HttpStatusBadge,
} from "@/client/features/audit/shared";
import type { AuditResultsData } from "@/client/features/audit/results/types";
import {
  countActiveFilters,
  EmptyTableMessage,
  PagesFilterBar,
  TableFilterToggle,
} from "@/client/features/audit/results/AuditResultsTableFilters";
import {
  EMPTY_PAGES_FILTERS,
  filterPages,
  nullableNumberSort,
  nullableStringSort,
  type PageRow,
  type PagesFilters,
} from "@/client/features/audit/results/AuditResultsTableFilterLogic";
import {
  charLengthTone,
  classifyCanonical,
  duplicateGroupsByContentHash,
  indexableDisplay,
  issueCountsByPageUrl,
  META_DESCRIPTION_LENGTH_RANGE,
  TITLE_LENGTH_RANGE,
  type CanonicalKind,
  type CharLengthTone,
  type PageIssueCounts,
} from "@/client/features/audit/results/PageExplorerLogic";
import type { IssueSeverity } from "@/shared/audit-issues";

const pageColumnHelper = createColumnHelper<PageRow>();

const DEFAULT_COLUMN_VISIBILITY: VisibilityState = {
  canonical: false,
  crawlDepth: false,
  inSitemap: false,
  links: false,
  altGaps: false,
  structuredData: false,
  duplicate: false,
  fetch: false,
  redirectTarget: false,
};

const COLUMN_LABELS: Record<string, string> = {
  url: "URL",
  statusCode: "Status",
  title: "Title",
  issues: "Issues",
  indexable: "Indexable",
  metaDescription: "Meta description",
  h1Count: "H1",
  wordCount: "Words",
  images: "Images",
  responseTimeMs: "Speed",
  canonical: "Canonical",
  crawlDepth: "Depth",
  inSitemap: "In sitemap",
  links: "Links",
  altGaps: "Alt gaps",
  structuredData: "Structured data",
  duplicate: "Duplicate",
  fetch: "Fetch",
  redirectTarget: "Redirect target",
};

const LENGTH_TONE_CLASS: Record<CharLengthTone, string> = {
  green: "badge-success",
  amber: "badge-warning",
  red: "badge-error",
};

const ISSUE_SEVERITY_CLASS: Record<IssueSeverity, string> = {
  critical: "badge-error",
  warning: "badge-warning",
  info: "badge-ghost",
};

const CANONICAL_CLASS: Record<CanonicalKind, string> = {
  self: "badge-success",
  other: "badge-warning",
  missing: "badge-ghost",
};

/**
 * Path shown in the URL/redirect cells. Redirect sources on another host
 * (e.g. the apex domain 301ing to www) would otherwise render identically
 * to their target, so include the host whenever it differs from the
 * site's canonical host.
 */
function displayPath(url: string, canonicalHost: string): string {
  const host = extractHostname(url);
  const path = extractPathname(url);
  return host === canonicalHost ? path : host + path;
}

/**
 * The host most of the site's real (2xx) pages live on. The start URL's host
 * is only a fallback: audits often start from the apex domain of a site that
 * canonicalizes to www, and prefixing every row with the host is exactly the
 * noise this display is meant to avoid.
 */
function predominantHost(pages: PageRow[], startUrl: string): string {
  const counts = new Map<string, number>();
  for (const page of pages) {
    if (page.statusCode === null || page.statusCode >= 300) continue;
    const host = extractHostname(page.url);
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  let best = extractHostname(startUrl);
  let bestCount = 0;
  for (const [host, count] of counts) {
    if (count > bestCount) {
      best = host;
      bestCount = count;
    }
  }
  return best;
}

function isRedirect(row: PageRow): boolean {
  return (
    row.statusCode !== null && row.statusCode >= 300 && row.statusCode < 400
  );
}

/** Redirects and blocked/errored fetches have no analyzed content — their
 * zero H1/word/image counts are an artifact, not a finding. */
function hasAnalyzedContent(row: PageRow): boolean {
  return row.fetchClass === "ok" && !isRedirect(row);
}

const EmptyCell = () => <span className="text-xs text-base-content/40">-</span>;
const DashCell = () => <span className="text-xs text-base-content/40">—</span>;

function CharLengthBadge({
  value,
  min,
  max,
}: {
  value: string | null;
  min: number;
  max: number;
}) {
  const length = value?.trim().length ?? 0;
  const tone = charLengthTone(value, min, max);
  return (
    <span
      className={`badge badge-xs shrink-0 tabular-nums ${LENGTH_TONE_CLASS[tone]}`}
      title={`${length} characters`}
    >
      {length}
    </span>
  );
}

function YesNo({ value }: { value: boolean }) {
  return value ? "yes" : "no";
}

function buildPagesColumns({
  canonicalHost,
  missingTitlePageIds,
  issueCounts,
  duplicateGroups,
}: {
  canonicalHost: string;
  missingTitlePageIds: Set<string>;
  issueCounts: Map<string, PageIssueCounts>;
  duplicateGroups: Map<string, number>;
}): ColumnDef<PageRow>[] {
  return [
    pageColumnHelper.accessor("url", {
      header: ({ column }) => <SortableHeader column={column} label="URL" />,
      cell: ({ getValue }) => {
        const url = getValue();
        return (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="link link-primary inline-flex items-center gap-1 text-xs"
          >
            <span className="truncate">{displayPath(url, canonicalHost)}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
        );
      },
      meta: { cellClassName: "max-w-[240px] truncate" },
    }),
    pageColumnHelper.accessor("statusCode", {
      header: ({ column }) => <SortableHeader column={column} label="Status" />,
      cell: ({ getValue }) => <HttpStatusBadge code={getValue()} />,
      sortingFn: nullableNumberSort,
    }),
    pageColumnHelper.accessor("title", {
      header: ({ column }) => <SortableHeader column={column} label="Title" />,
      cell: ({ getValue, row }) => {
        if (isRedirect(row.original)) {
          const target = row.original.redirectUrl;
          return (
            <span className="text-xs text-base-content/60">
              → {target ? displayPath(target, canonicalHost) : "redirect"}
            </span>
          );
        }
        const title = getValue();
        if (title) {
          return (
            <span className="inline-flex max-w-full items-center gap-1.5">
              <span className="break-words">{title}</span>
              <CharLengthBadge
                value={title}
                min={TITLE_LENGTH_RANGE.min}
                max={TITLE_LENGTH_RANGE.max}
              />
            </span>
          );
        }
        // Red only when the engine flagged it — a 200 that isn't an HTML
        // document (robots.txt, security.txt) legitimately has no title.
        return (
          <span className="inline-flex items-center gap-1.5">
            {missingTitlePageIds.has(row.original.id) ? (
              <span className="text-error text-xs">missing</span>
            ) : (
              <EmptyCell />
            )}
            <CharLengthBadge
              value={title}
              min={TITLE_LENGTH_RANGE.min}
              max={TITLE_LENGTH_RANGE.max}
            />
          </span>
        );
      },
      sortingFn: nullableStringSort,
      meta: { cellClassName: "max-w-[360px]" },
    }),
    pageColumnHelper.display({
      id: "issues",
      header: ({ column }) => <SortableHeader column={column} label="Issues" />,
      cell: ({ row }) => {
        const counts = issueCounts.get(row.original.url);
        if (!counts || counts.count === 0) return <DashCell />;
        return (
          <span
            className={`badge badge-sm tabular-nums ${ISSUE_SEVERITY_CLASS[counts.worstSeverity]}`}
          >
            {counts.count}
          </span>
        );
      },
      enableSorting: true,
      sortingFn: (left, right) =>
        (issueCounts.get(left.original.url)?.count ?? 0) -
        (issueCounts.get(right.original.url)?.count ?? 0),
    }),
    pageColumnHelper.accessor("isIndexable", {
      id: "indexable",
      header: ({ column }) => (
        <SortableHeader column={column} label="Indexable" />
      ),
      cell: ({ row }) => {
        const display = indexableDisplay(row.original);
        if (display.indexable) {
          return <span className="badge badge-success badge-sm">yes</span>;
        }
        return (
          <span className="badge badge-error badge-sm">
            no ({display.reason})
          </span>
        );
      },
    }),
    pageColumnHelper.accessor("metaDescription", {
      header: ({ column }) => (
        <SortableHeader column={column} label="Meta description" />
      ),
      cell: ({ getValue }) => {
        const meta = getValue();
        return (
          <span className="inline-flex max-w-full items-center gap-1.5">
            {meta ? (
              <span className="truncate" title={meta}>
                {meta}
              </span>
            ) : (
              <DashCell />
            )}
            <CharLengthBadge
              value={meta}
              min={META_DESCRIPTION_LENGTH_RANGE.min}
              max={META_DESCRIPTION_LENGTH_RANGE.max}
            />
          </span>
        );
      },
      sortingFn: nullableStringSort,
      meta: { cellClassName: "max-w-[280px]" },
    }),
    pageColumnHelper.accessor("h1Count", {
      header: ({ column }) => <SortableHeader column={column} label="H1" />,
      cell: ({ getValue, row }) =>
        hasAnalyzedContent(row.original) ? getValue() : <EmptyCell />,
    }),
    pageColumnHelper.accessor("wordCount", {
      header: ({ column }) => <SortableHeader column={column} label="Words" />,
      cell: ({ getValue, row }) =>
        hasAnalyzedContent(row.original) ? getValue() : <EmptyCell />,
    }),
    pageColumnHelper.display({
      id: "images",
      header: ({ column }) => <SortableHeader column={column} label="Images" />,
      cell: ({ row }) => {
        if (!hasAnalyzedContent(row.original)) return <EmptyCell />;
        return row.original.imagesMissingAlt > 0 ? (
          <span className="text-warning">
            {row.original.imagesMissingAlt}/{row.original.imagesTotal}
          </span>
        ) : (
          row.original.imagesTotal
        );
      },
      enableSorting: true,
      sortingFn: (left, right) =>
        left.original.imagesMissingAlt - right.original.imagesMissingAlt ||
        left.original.imagesTotal - right.original.imagesTotal,
    }),
    pageColumnHelper.accessor("responseTimeMs", {
      header: ({ column }) => <SortableHeader column={column} label="Speed" />,
      cell: ({ getValue }) => {
        const value = getValue();
        return value ? (
          <span className="text-xs">{value}ms</span>
        ) : (
          <EmptyCell />
        );
      },
      sortingFn: nullableNumberSort,
    }),
    pageColumnHelper.accessor("canonicalUrl", {
      id: "canonical",
      header: ({ column }) => (
        <SortableHeader column={column} label="Canonical" />
      ),
      cell: ({ row }) => {
        const kind = classifyCanonical(
          row.original.url,
          row.original.canonicalUrl,
        );
        return (
          <span
            className={`badge badge-sm ${CANONICAL_CLASS[kind]}`}
            title={
              kind === "other" ? (row.original.canonicalUrl ?? "") : undefined
            }
          >
            {kind}
          </span>
        );
      },
      sortingFn: nullableStringSort,
    }),
    pageColumnHelper.accessor("crawlDepth", {
      header: ({ column }) => <SortableHeader column={column} label="Depth" />,
      cell: ({ getValue }) => {
        const depth = getValue();
        return depth == null ? <DashCell /> : depth;
      },
      sortingFn: nullableNumberSort,
    }),
    pageColumnHelper.accessor("inSitemap", {
      header: ({ column }) => (
        <SortableHeader column={column} label="In sitemap" />
      ),
      cell: ({ getValue }) => <YesNo value={getValue()} />,
    }),
    pageColumnHelper.display({
      id: "links",
      header: ({ column }) => <SortableHeader column={column} label="Links" />,
      cell: ({ row }) =>
        `${row.original.internalLinkCount} / ${row.original.externalLinkCount}`,
      enableSorting: true,
      sortingFn: (left, right) =>
        left.original.internalLinkCount - right.original.internalLinkCount ||
        left.original.externalLinkCount - right.original.externalLinkCount,
    }),
    pageColumnHelper.display({
      id: "altGaps",
      header: ({ column }) => (
        <SortableHeader column={column} label="Alt gaps" />
      ),
      cell: ({ row }) =>
        `${row.original.imagesMissingAlt} of ${row.original.imagesTotal}`,
      enableSorting: true,
      sortingFn: (left, right) =>
        left.original.imagesMissingAlt - right.original.imagesMissingAlt ||
        left.original.imagesTotal - right.original.imagesTotal,
    }),
    pageColumnHelper.accessor("hasStructuredData", {
      id: "structuredData",
      header: ({ column }) => (
        <SortableHeader column={column} label="Structured data" />
      ),
      cell: ({ getValue }) => <YesNo value={getValue()} />,
    }),
    pageColumnHelper.display({
      id: "duplicate",
      header: ({ column }) => (
        <SortableHeader column={column} label="Duplicate" />
      ),
      cell: ({ row }) => {
        const hash = row.original.contentHash?.trim() ?? "";
        const count = hash ? (duplicateGroups.get(hash) ?? 0) : 0;
        if (count <= 1) return <DashCell />;
        return (
          <span className="badge badge-warning badge-sm tabular-nums">
            ×{count}
          </span>
        );
      },
      enableSorting: true,
      sortingFn: (left, right) => {
        const leftHash = left.original.contentHash?.trim() ?? "";
        const rightHash = right.original.contentHash?.trim() ?? "";
        return (
          (leftHash ? (duplicateGroups.get(leftHash) ?? 0) : 0) -
          (rightHash ? (duplicateGroups.get(rightHash) ?? 0) : 0)
        );
      },
    }),
    pageColumnHelper.accessor("fetchClass", {
      id: "fetch",
      header: ({ column }) => <SortableHeader column={column} label="Fetch" />,
      cell: ({ getValue }) => {
        const fetchClass = getValue();
        if (fetchClass === "ok") return fetchClass;
        return (
          <span
            className={`badge badge-sm ${fetchClass === "blocked" ? "badge-warning" : "badge-error"}`}
          >
            {fetchClass}
          </span>
        );
      },
    }),
    pageColumnHelper.accessor("redirectUrl", {
      id: "redirectTarget",
      header: ({ column }) => (
        <SortableHeader column={column} label="Redirect target" />
      ),
      cell: ({ getValue }) => {
        const target = getValue();
        if (!target) return <DashCell />;
        return (
          <span className="truncate text-xs" title={target}>
            {displayPath(target, canonicalHost)}
          </span>
        );
      },
      sortingFn: nullableStringSort,
      meta: { cellClassName: "max-w-[200px] truncate" },
    }),
  ];
}

function ColumnsDropdown({
  columns,
}: {
  columns: Array<{
    id: string;
    visible: boolean;
    onToggle: (event: unknown) => void;
  }>;
}) {
  return (
    <div className="dropdown dropdown-end">
      <button
        type="button"
        tabIndex={0}
        aria-haspopup="menu"
        className="btn btn-ghost btn-sm gap-1.5"
      >
        <Columns3 className="size-3.5" />
        Columns
        <ChevronDown className="size-3 opacity-60" />
      </button>
      <ul
        tabIndex={0}
        role="menu"
        className="dropdown-content menu z-20 max-h-80 w-56 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
      >
        {columns.map((column) => (
          <li key={column.id} role="none">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="checkbox checkbox-xs"
                checked={column.visible}
                onChange={column.onToggle}
              />
              {COLUMN_LABELS[column.id] ?? column.id}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PagesTable({
  pages,
  startUrl,
  issues,
}: {
  pages: AuditResultsData["pages"];
  startUrl: string;
  issues: AuditResultsData["issues"];
}) {
  const [filters, setFilters] = useState<PagesFilters>(EMPTY_PAGES_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    DEFAULT_COLUMN_VISIBILITY,
  );
  // URL order reads as a site inventory; status-first would open the table
  // on its most boring rows (redirects) whenever a site has no errors.
  const [sorting, setSorting] = useState<SortingState>([
    { id: "url", desc: false },
  ]);
  const activeFilterCount = countActiveFilters(filters, EMPTY_PAGES_FILTERS);
  const filteredPages = useMemo(
    () => filterPages(pages, filters, issues),
    [filters, issues, pages],
  );
  const issueCounts = useMemo(() => issueCountsByPageUrl(issues), [issues]);
  const duplicateGroups = useMemo(
    () => duplicateGroupsByContentHash(pages),
    [pages],
  );
  const columns = useMemo(
    () =>
      buildPagesColumns({
        canonicalHost: predominantHost(pages, startUrl),
        missingTitlePageIds: new Set(
          issues
            .filter((issue) => issue.issueType === "missing-title")
            .map((issue) => issue.pageId)
            .filter((pageId): pageId is string => pageId !== null),
        ),
        issueCounts,
        duplicateGroups,
      }),
    [duplicateGroups, issueCounts, issues, pages, startUrl],
  );
  const table = useAppTable({
    data: filteredPages,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    withSorting: true,
  });

  return (
    <div className="space-y-3">
      <TableFilterToggle
        showFilters={showFilters}
        onToggle={() => setShowFilters((current) => !current)}
        activeFilterCount={activeFilterCount}
        resultCount={filteredPages.length}
        totalCount={pages.length}
        extra={
          <ColumnsDropdown
            columns={table.getAllLeafColumns().map((column) => ({
              id: column.id,
              visible: column.getIsVisible(),
              onToggle: column.getToggleVisibilityHandler(),
            }))}
          />
        }
      />
      {showFilters ? (
        <PagesFilterBar
          filters={filters}
          onChange={setFilters}
          activeFilterCount={activeFilterCount}
          onReset={() => setFilters(EMPTY_PAGES_FILTERS)}
        />
      ) : null}
      <AppDataTable
        table={table}
        className="table table-sm"
        empty={<EmptyTableMessage label="No pages match these filters." />}
      />
    </div>
  );
}
