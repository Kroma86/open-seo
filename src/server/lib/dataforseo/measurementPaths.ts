const QUEUED_PATH =
  /^\/v3\/(?:ai_optimization\/chat_gpt\/llm_scraper|serp\/google\/ai_mode)\/(?:task_post|task_get\/advanced\/[a-f0-9-]+)$/i;
export function assertMeasurementRequestPath(url: string) {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://api.dataforseo.com" ||
    parsed.pathname.includes("/live") ||
    !QUEUED_PATH.test(parsed.pathname)
  )
    throw new Error(
      "Measurement v2 permits only queued task_post/task_get paths",
    );
}
