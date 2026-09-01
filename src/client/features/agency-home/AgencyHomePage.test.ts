import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
  }: {
    children?: React.ReactNode;
    className?: string;
    to?: string;
    params?: unknown;
    onClick?: unknown;
  }) => createElement("a", { className, href: "#" }, children),
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "projects") {
      return {
        data: [
          {
            id: "proj_1",
            name: "NiceSEO",
            domain: "niceseo.ai",
            locationCode: 2840,
            languageCode: "en",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (queryKey[0] === "agency-home-missions") {
      return { data: [], isLoading: false, isError: false, error: null };
    }
    if (queryKey[0] === "agency-home-portfolio") {
      return { data: [], isLoading: false, isError: false, error: null };
    }
    if (queryKey[0] === "agency-home-alerts") {
      return { data: null, isLoading: false, isError: false, error: null };
    }
    return { data: undefined, isLoading: false, isError: false, error: null };
  },
}));

vi.mock("@/serverFunctions/agency-home", () => ({
  getAgencyHomeMissions: vi.fn(),
  getAgencyHomePortfolio: vi.fn(),
}));

vi.mock("@/serverFunctions/agency-ops", () => ({
  getLatestAlertCycle: vi.fn(),
}));

vi.mock("@/serverFunctions/projects", () => ({
  getProjects: vi.fn(),
}));

import { AgencyHomePage } from "./AgencyHomePage";
import { AgencyHomeWorkflowChips } from "./AgencyHomeWorkflowChips";
import { AGENCY_WORKFLOW_CHIPS } from "./workflowChips";
import {
  formatRelativeFinishedAt,
  projectFaviconUrl,
  storeSamAskDraft,
} from "./agencyHomeUtils";

describe("agency home smoke", () => {
  it("renders the home shell with prompt and workflows", () => {
    const markup = renderToStaticMarkup(createElement(AgencyHomePage));
    expect(markup).toContain("Put Sam to work");
    expect(markup).toContain("Ask Sam to do anything");
    expect(markup).toContain("Workflows");
    expect(markup).toContain("Missions");
    expect(markup).toContain("Alerts");
    expect(markup).toContain("Portfolio");
  });

  it("exposes curated workflow chips from static config", () => {
    const onSelect = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(AgencyHomeWorkflowChips, { onSelect }),
    );
    expect(AGENCY_WORKFLOW_CHIPS.length).toBeGreaterThanOrEqual(6);
    for (const chip of AGENCY_WORKFLOW_CHIPS) {
      expect(markup).toContain(chip.label);
      expect(chip.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it("formats relative times and favicon hosts honestly", () => {
    expect(formatRelativeFinishedAt(null)).toBe("in progress");
    expect(formatRelativeFinishedAt("not-a-date")).toBe("—");
    expect(projectFaviconUrl(null)).toBeNull();
    expect(projectFaviconUrl("https://www.niceseo.ai/path")).toContain(
      "niceseo.ai",
    );
  });

  it("stores Ask-Sam drafts under the shared sessionStorage key", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    storeSamAskDraft("proj_1", "  Run a site health check  ");
    expect(setItem).toHaveBeenCalledWith(
      "sam-loops-ask:proj_1",
      "Run a site health check",
    );
    setItem.mockRestore();
  });
});
