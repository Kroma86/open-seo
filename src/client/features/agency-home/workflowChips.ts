/**
 * Curated Sam workflow chips for the agency home.
 * Edit this file to change labels/prompts — no backend.
 */
export type AgencyWorkflowChip = {
  id: string;
  label: string;
  /** Prefills Sam chat via the sam-loops-ask: sessionStorage handoff. */
  prompt: string;
};

export const AGENCY_WORKFLOW_CHIPS: AgencyWorkflowChip[] = [
  {
    id: "site-health",
    label: "Site health check",
    prompt:
      "Run a site health check: summarize the latest crawl issues and what changed since the last completed audit. Be honest about gaps — say not measured when data is missing.",
  },
  {
    id: "keyword-gap",
    label: "Keyword gap",
    prompt:
      "Find a keyword gap vs our top SERP competitors: keywords they rank for that we do not. Prioritize a short target list and label any paid DataForSEO calls.",
  },
  {
    id: "ai-visibility",
    label: "AI visibility",
    prompt:
      "Check our AI visibility: where our brand shows up in LLM answers for priority prompts, and what to do next. Use real tool results only.",
  },
  {
    id: "location-pages",
    label: "Location page brief",
    prompt:
      "Draft a location page brief for our priority markets: pages to create or improve, with evidence from Search Console and rank tracking where available.",
  },
  {
    id: "rank-slippage",
    label: "Rank check",
    prompt:
      "Check rank slippage: which tracked keywords moved down recently, by how much, and what looks worth acting on first.",
  },
  {
    id: "seo-audit",
    label: "SEO audit",
    prompt:
      "Run an SEO audit and deliver a one-page plain-language report centered on a single do-this-week action.",
  },
  {
    id: "striking-distance",
    label: "Striking distance",
    prompt:
      "Find striking-distance opportunities from Search Console (roughly positions 5–20) and recommend the highest-leverage pages to improve.",
  },
  {
    id: "page-growth",
    label: "Page growth",
    prompt:
      "Suggest a page growth plan: new or expanded pages that match demand we can evidence from GSC, rank tracking, or keyword research.",
  },
];
