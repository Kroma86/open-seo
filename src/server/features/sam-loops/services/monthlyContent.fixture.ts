// Synthetic content for validation tests; no client records.
const url = "https://example.com/services/drains";
const page = "Example Plumbing clears blocked household drains. The team first inspects the blockage and explains the proposed repair.";
const paragraph = "A careful inspection helps explain where a blockage began and what the next step should be. Homeowners can write down when they first noticed slow drainage and describe which fixtures are affected. This gives the team useful context before it inspects the drain. Avoid guessing about the cause before the inspection is complete. Keep a clear record of the symptoms so the proposed repair can be discussed in the context of what was observed. ";
export const article = { outcome: "draft", reason: "", targetKeyword: "drain cleaning", title: "Understanding a drain inspection", body: Array.from({ length: 5 }, (_, i) => `## Part ${i + 1}\n\n${paragraph.repeat(2)}`).join("\n\n"), sources: [{ url, excerpt: "Example Plumbing clears blocked household drains." }] };
export const source = { toolName: "read_pages", output: { blocked: false, pages: [{ url, title: "Drains", text: page }] } };
export const saved = { toolName: "list_saved_keywords", output: { data: { rows: [{ keyword: "drain cleaning" }] } } };
const tracked = { toolName: "get_rank_tracker", output: { data: { results: { rows: [{ keyword: "drain cleaning" }], run: null } } } };
const query = { toolName: "get_search_console_performance", output: { data: { ok: true, dimensions: ["page", "query"], rows: [{ keys: [url, "drain cleaning"] }] } } };
