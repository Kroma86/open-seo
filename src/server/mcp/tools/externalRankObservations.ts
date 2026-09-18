import { z } from "zod";

const SOURCE_LABEL = "Hermes daily rank checks" as const;
const MAX_OBSERVATIONS = 500;
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export type ExternalRankObservationRow = {
  keyword: string;
  country: string;
  position: number | null;
  url: string | null;
  checkedAt: string;
  device: null;
  depth: null;
};

export type ExternalRankObservations = {
  source: typeof SOURCE_LABEL;
  status: "available" | "missing" | "invalid";
  updatedAt: string | null;
  stale: boolean | null;
  method: "unspecified";
  comparisonsSupported: false;
  rows: ExternalRankObservationRow[];
  note: string;
};

const LIMITS =
  "The legacy collector did not save device, search depth, success status or measurement method, so all of those stay unknown. " +
  "A null position only means no position was stored; it does not mean the keyword was absent from the top results of any depth. " +
  "These are read-only imported display records, not native organic rankings, and they cannot be used to compare positions or describe ranking changes or improvements. " +
  "This is a partial import of whatever the feed happened to contain, not full rank coverage.";

const NOTES = {
  available: `Showing rank observations copied from an external feed. ${LIMITS}`,
  missing: `No external rank observations were supplied, so there is nothing to show. Having no data is not the same as having data that could not be read. ${LIMITS}`,
  invalid: `The external rank observation feed was rejected because at least one record was malformed or contradicted another record, so no rows are shown. This is different from simply having no observations. ${LIMITS}`,
} as const;

function isHttpUrlWithoutCredentials(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === ""
  );
}

const observationSchema = z.object({
  keyword: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => value.trim().length > 0),
  country: z
    .string()
    .min(1)
    .max(80)
    .refine((value) => value.trim().length > 0),
  position: z.number().int().positive().max(10000).nullable(),
  url: z.string().refine(isHttpUrlWithoutCredentials).nullable(),
  checked_at: z.iso
    .datetime({ offset: true })
    .refine((value) => !Number.isNaN(Date.parse(value))),
});

const feedSchema = z.object({
  source: z.literal("hermes-rank-history"),
  observations: z.array(observationSchema).max(MAX_OBSERVATIONS),
});

type Entry = {
  normKeyword: string;
  normCountry: string;
  keyword: string;
  country: string;
  position: number | null;
  url: string | null;
  timeMs: number;
};

function emptyResult(status: "missing" | "invalid"): ExternalRankObservations {
  return {
    source: SOURCE_LABEL,
    status,
    updatedAt: null,
    stale: null,
    method: "unspecified",
    comparisonsSupported: false,
    rows: [],
    note: NOTES[status],
  };
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function groupKey(normKeyword: string, normCountry: string): string {
  return JSON.stringify([normKeyword, normCountry]);
}

export function parseExternalRankObservations(
  payload: unknown,
  now: Date,
): ExternalRankObservations {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    return emptyResult("invalid");
  if (payload === undefined || payload === null) return emptyResult("missing");

  const parsed = feedSchema.safeParse(payload);
  if (!parsed.success) return emptyResult("invalid");
  if (parsed.data.observations.length === 0) return emptyResult("missing");

  const nowMs = now.getTime();
  const groups = new Map<string, Entry[]>();

  for (const observation of parsed.data.observations) {
    const timeMs = Date.parse(observation.checked_at);
    if (timeMs > nowMs) return emptyResult("invalid");

    const keyword = observation.keyword.trim();
    const country = observation.country.trim();
    const normKeyword = keyword.toLowerCase();
    const normCountry = country.toLowerCase();
    const key = groupKey(normKeyword, normCountry);
    const entry: Entry = {
      normKeyword,
      normCountry,
      keyword,
      country,
      position: observation.position,
      url: observation.url,
      timeMs,
    };
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  const sortable: Array<{ entry: Entry; row: ExternalRankObservationRow }> = [];
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const bucket of groups.values()) {
    let newestMs = Number.NEGATIVE_INFINITY;
    for (const entry of bucket) {
      if (entry.timeMs > newestMs) newestMs = entry.timeMs;
    }
    const newest = bucket.filter((entry) => entry.timeMs === newestMs);
    const winner = newest[0];
    const conflicting = newest.some(
      (entry) => entry.position !== winner.position || entry.url !== winner.url,
    );
    if (conflicting) return emptyResult("invalid");

    if (newestMs > latestMs) latestMs = newestMs;
    sortable.push({
      entry: winner,
      row: {
        keyword: newest.map((entry) => entry.keyword).sort(compareText)[0],
        country: newest.map((entry) => entry.country).sort(compareText)[0],
        position: winner.position,
        url: winner.url,
        checkedAt: new Date(newestMs).toISOString(),
        device: null,
        depth: null,
      },
    });
  }

  sortable.sort(
    (a, b) =>
      compareText(a.entry.normKeyword, b.entry.normKeyword) ||
      compareText(a.entry.normCountry, b.entry.normCountry) ||
      compareText(a.entry.keyword, b.entry.keyword) ||
      compareText(a.entry.country, b.entry.country),
  );

  return {
    source: SOURCE_LABEL,
    status: "available",
    updatedAt: new Date(latestMs).toISOString(),
    stale: nowMs - latestMs > STALE_AFTER_MS,
    method: "unspecified",
    comparisonsSupported: false,
    rows: sortable.map((item) => item.row),
    note: NOTES.available,
  };
}
