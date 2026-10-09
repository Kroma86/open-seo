import { useMemo, useState } from "react";
import { type SortingState, type VisibilityState } from "@tanstack/react-table";
import { ChevronDown, Columns3 } from "lucide-react";
import {
  AppDataTable,
  useAppTable,
} from "@/client/components/table/AppDataTable";
import { extractHostname } from "@/client/features/audit/shared";
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
  type PageRow,
  type PagesFilters,
} from "@/client/features/audit/results/AuditResultsTableFilterLogic";
import {
  duplicateGroupsByContentHash,
  issueCountsByPageUrl,
} from "@/client/features/audit/results/PageExplorerLogic";
import { buildPagesColumns } from "@/client/features/audit/results/PagesTableColumns";

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
