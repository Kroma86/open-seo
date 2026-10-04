#!/usr/bin/env node
// Dry-run audit for mangled phone numbers stored in project context.
//
// Context sections are prose written by agents, and at least two projects had
// their phone stored with the country code folded into the area code and the
// last digit dropped ("+1 (178) 776-7060" for 778-776-7060). This lists every
// stored phone-shaped value, the canonical form formatNanpPhone would write,
// and the values that cannot be recovered mechanically (a digit is gone, so
// they fail NANP validation and need a human).
//
// DRY RUN ONLY. It prints a table and writes nothing.
//
// Usage:
//   node scripts/fix-context-phones.mjs --database <d1-name> [--local]

import { execFileSync } from "node:child_process";
import process from "node:process";

// Keep in sync with src/shared/phone.ts (an .mjs script cannot import the TS
// module). Strip non-digits; 11 digits starting with 1 drops the country
// code; 10 digits must split into area + exchange + line with neither code
// starting 0/1; anything else stays raw.
function formatNanpPhone(raw) {
  const digits = raw.replace(/\D/g, "");
  const national =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return raw;
  const area = national.slice(0, 3);
  const exchange = national.slice(3, 6);
  const line = national.slice(6);
  if (/^[01]/.test(area) || /^[01]/.test(exchange)) return raw;
  return `+1 (${area}) ${exchange}-${line}`;
}

function digitsOf(raw) {
  return raw.replace(/\D/g, "");
}

// Phone-shaped values: a labelled "Phone:" line, or any NANP-shaped run of
// digits, parens, dashes and spaces long enough to be a number.
const LABELLED_PHONE = /phone\s*:\s*([^\n;]+)/gi;
const PHONE_SHAPE =
  /\+\d[\d\s().-]{8,}\d|\(\d{3}\)\s*\d{3}[-\s]\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g;

function extractPhones(content) {
  const found = new Set();
  for (const match of content.matchAll(LABELLED_PHONE)) {
    const value = match[1].trim();
    const shaped = value.match(PHONE_SHAPE);
    if (shaped) for (const phone of shaped) found.add(phone.trim());
    else if (/\d{5,}/.test(digitsOf(value))) found.add(value);
  }
  for (const match of content.matchAll(PHONE_SHAPE)) {
    found.add(match[0].trim());
  }
  return [...found];
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const databaseName = args.database;
const isLocal = args.local === "true";

if (!databaseName) {
  console.error(
    "Usage: node scripts/fix-context-phones.mjs --database <d1-name> [--local]\nDry run only: prints affected rows, writes nothing.",
  );
  process.exit(1);
}

function runJsonQuery(sql) {
  const output = execFileSync(
    "wrangler",
    [
      "d1",
      "execute",
      databaseName,
      isLocal ? "--local" : "--remote",
      "--json",
      "--command",
      sql,
    ],
    { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(output);
  const failed = parsed.find((result) => result.success === false);
  if (failed) throw new Error(`Wrangler query failed for ${databaseName}.`);
  return parsed.flatMap((result) => result.results ?? []);
}

const rows = runJsonQuery(`
  SELECT s.project_id, s.key, p.domain, s.content
  FROM project_context_sections s
  LEFT JOIN projects p ON p.id = s.project_id
  WHERE s.content LIKE '%phone%' OR s.content LIKE '%Phone%' OR s.content LIKE '%+1%';
`);

const findings = [];
for (const row of rows) {
  for (const phone of extractPhones(row.content)) {
    const formatted = formatNanpPhone(phone);
    if (formatted !== phone) {
      findings.push({
        project_id: row.project_id,
        domain: row.domain ?? "",
        section: row.key,
        stored: phone,
        proposed: formatted,
        verdict: "fixable",
      });
      continue;
    }
    const digits = digitsOf(phone);
    const national =
      digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    // Flag only values that look like a NANP number but fail validation
    // (area or exchange code starting 0/1) — the signature of a mangled
    // store. Canonical values format back to themselves and are skipped.
    const invalidNanp =
      national.length === 10 &&
      (/^[01]/.test(national.slice(0, 3)) ||
        /^[01]/.test(national.slice(3, 6)));
    if (invalidNanp) {
      findings.push({
        project_id: row.project_id,
        domain: row.domain ?? "",
        section: row.key,
        stored: phone,
        proposed: "(needs human - not a valid NANP number)",
        verdict: "review",
      });
    }
  }
}

console.log(
  `Dry run on ${databaseName} (${isLocal ? "local" : "remote"}): ${rows.length} context sections scanned, ${findings.length} phone values flagged. Nothing was written.`,
);
if (findings.length > 0) console.table(findings);
