#!/usr/bin/env node
// Repair an alchemy state document that a killed deploy left behind.
//
// The runbook used to say "PUT the state document by hand with curl". That is
// how NIC-775 was cleared, and it is a bad instruction: the dangerous part is
// not deciding what to change, it is assembling the JSON without dropping a
// field. `downstream` is the trap — the Worker reads the Access `aud` through
// it, so a repair that forgets to carry it forward looks like it worked and
// quietly breaks the gate.
//
// This does the mechanical parts and refuses the unsafe ones:
//
//   * dry run unless --apply
//   * writes a timestamped backup before any write
//   * will not repoint at an application id it could not see live in Cloudflare
//   * will not produce a document that loses a non-empty `downstream`
//   * will not touch a document that is not actually drifted
//
// Usage
//   node scripts/repair-alchemy-state.mjs --fqn SelfHostMcpAccess
//   node scripts/repair-alchemy-state.mjs --fqn SelfHostMcpAccess --apply
//   node scripts/repair-alchemy-state.mjs --fqn SelfHostMcpAccess \
//        --repoint b490d2fe-08b6-4e43-89a5-d2946d2ad6b1 --apply
//
// Live verification needs a Cloudflare token. It uses CLOUDFLARE_API_TOKEN when
// set, otherwise the access token alchemy stored at login. That token expires;
// when it has, this says so and stops rather than guessing — refresh it by
// running `python3 scripts/restore-openseo-managed-oauth.py --dry-run`, which
// owns the refresh flow, or export CLOUDFLARE_API_TOKEN.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { SETTLED_STATUSES, readStateStoreCreds } from "./alchemy-state-health.mjs";

const settled = new Set(SETTLED_STATUSES);
const UA = "open-seo-state-repair/1.0";
const DEFAULT_ACCOUNT_ID = "9e03005588cee6cae23a89b800c2beb3";

// ---------------------------------------------------------------- pure core

/** One-screen view of what the state document currently claims. Pure. */
export function summarizeDoc(doc) {
  return {
    fqn: doc?.fqn,
    status: doc?.status,
    settled: settled.has(doc?.status),
    applicationId: doc?.attr?.applicationId,
    aud: doc?.attr?.aud,
    downstream: doc?.downstream ?? [],
    oldDownstream: doc?.old?.downstream ?? [],
    hasOld: Boolean(doc?.old),
  };
}

/**
 * Decide what to do. Pure — no network, no clock, no filesystem.
 *
 * live: { applicationId, aud } as observed in Cloudflare, or undefined when
 * verification did not run or did not find an application on the domain.
 */
export function planRepair({ doc, live, targetAppId }) {
  const refusals = [];
  if (!doc) {
    return { action: "none", changes: [], refusals: ["no state document found"] };
  }
  const now = summarizeDoc(doc);
  const changes = [];

  if (targetAppId) {
    if (!live?.applicationId) {
      refusals.push(
        "cannot verify the target application in Cloudflare — refusing to repoint state at an id that was not observed live",
      );
    } else if (live.applicationId !== targetAppId) {
      refusals.push(
        `the live application on this domain is ${live.applicationId}, not the requested ${targetAppId} — refusing`,
      );
    }
    if (refusals.length > 0) return { action: "none", changes, refusals };

    if (now.applicationId !== targetAppId) {
      changes.push({ field: "attr.applicationId", from: now.applicationId, to: targetAppId });
    }
    if (live.aud && now.aud !== live.aud) {
      changes.push({ field: "attr.aud", from: now.aud, to: live.aud });
    }
  } else {
    if (now.settled) {
      return {
        action: "none",
        changes: [],
        refusals: [],
        reason: `status is ${now.status} — nothing to repair`,
      };
    }
    if (live?.applicationId && now.applicationId !== live.applicationId) {
      return {
        action: "none",
        changes: [],
        refusals: [
          `state holds ${now.applicationId} but the live application on this domain is ${live.applicationId}.`,
          `Re-run with --repoint ${live.applicationId} once you have confirmed that is the application you mean.`,
        ],
      };
    }
  }

  if (!now.settled) {
    changes.push({ field: "status", from: now.status, to: "updated" });
  }
  if (now.hasOld) {
    changes.push({ field: "old", from: "present", to: "dropped" });
  }

  // The trap. `old` carries the pre-update snapshot; when the interrupted write
  // blanked `downstream`, the value to restore is in there.
  if (now.downstream.length === 0 && now.oldDownstream.length > 0) {
    changes.push({
      field: "downstream",
      from: JSON.stringify(now.downstream),
      to: JSON.stringify(now.oldDownstream),
    });
  }

  if (changes.length === 0) {
    return { action: "none", changes: [], refusals: [], reason: "already consistent" };
  }
  return {
    action: targetAppId ? "repoint" : "settle",
    changes,
    refusals,
  };
}

/** Produce the repaired document. Never mutates the input. Pure. */
export function applyPlanToDoc(doc, plan) {
  if (plan.action === "none" || plan.refusals?.length) return doc;
  const next = structuredClone(doc);
  for (const change of plan.changes) {
    switch (change.field) {
      case "attr.applicationId":
        next.attr = { ...next.attr, applicationId: change.to };
        break;
      case "attr.aud":
        next.attr = { ...next.attr, aud: change.to };
        break;
      case "status":
        next.status = change.to;
        break;
      case "old":
        delete next.old;
        break;
      case "downstream":
        next.downstream = JSON.parse(change.to);
        break;
      default:
        throw new Error(`unknown change field: ${change.field}`);
    }
  }
  return next;
}

/**
 * Last gate before a write. A repair that loses a non-empty `downstream` is the
 * specific mistake this tool exists to prevent, so it is checked against the
 * produced document rather than trusted from the plan. Pure.
 */
export function assertSafeToWrite(before, after) {
  const problems = [];
  const hadDownstream = (before?.downstream ?? []).length > 0 ||
    (before?.old?.downstream ?? []).length > 0;
  if (hadDownstream && (after?.downstream ?? []).length === 0) {
    problems.push(
      "refusing to write: the repaired document would have an empty `downstream` while the original had one (the Worker reads the Access aud through it)",
    );
  }
  if (!after?.attr?.applicationId) {
    problems.push("refusing to write: the repaired document has no attr.applicationId");
  }
  if (!settled.has(after?.status)) {
    problems.push(`refusing to write: status would still be ${after?.status}`);
  }
  return problems;
}

export function formatPlan(plan, { fqn }) {
  const out = [];
  if (plan.refusals?.length) {
    out.push(`REFUSED for ${fqn}:`, "");
    for (const r of plan.refusals) out.push(`  ${r}`);
    return out.join("\n");
  }
  if (plan.action === "none") {
    return `${fqn}: nothing to do — ${plan.reason ?? "no changes"}`;
  }
  out.push(`${fqn}: ${plan.action}`, "");
  for (const c of plan.changes) {
    out.push(`  ${c.field.padEnd(20)} ${c.from} -> ${c.to}`);
  }
  return out.join("\n");
}

// ----------------------------------------------------------------------- io

function parseArgs(argv) {
  const args = { stack: "open-seo", stage: "selfhost", apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--fqn") args.fqn = argv[++i];
    else if (a === "--repoint") args.repoint = argv[++i];
    else if (a === "--stack") args.stack = argv[++i];
    else if (a === "--stage") args.stage = argv[++i];
  }
  return args;
}

function cloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return { token: process.env.CLOUDFLARE_API_TOKEN, source: "CLOUDFLARE_API_TOKEN" };
  }
  const profile = process.env.ALCHEMY_PROFILE || "default";
  try {
    const creds = JSON.parse(
      readFileSync(`${homedir()}/.alchemy/credentials/${profile}/cf-oauth.json`, "utf8"),
    );
    if (Number(creds.expires ?? 0) < Date.now()) {
      return {
        error:
          "the Cloudflare token alchemy stored has expired. Refresh it with " +
          "`python3 scripts/restore-openseo-managed-oauth.py --dry-run`, or export CLOUDFLARE_API_TOKEN.",
      };
    }
    return { token: creds.access, source: `alchemy profile ${profile}` };
  } catch {
    return { error: "no Cloudflare token available (no CLOUDFLARE_API_TOKEN, no alchemy login)." };
  }
}

async function observeLiveApplication(recordedId) {
  const { token, error, source } = cloudflareToken();
  if (error) return { error };
  const accountId = process.env.OPENSEO_ACCESS_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps`,
    { headers: { Authorization: `Bearer ${token}`, "User-Agent": UA } },
  );
  if (!res.ok) {
    return { error: `Cloudflare Access API returned HTTP ${res.status} (token from ${source})` };
  }
  const body = await res.json();
  const apps = body?.result ?? [];
  const recorded = apps.find((a) => a.id === recordedId);
  return { apps, recorded, source };
}

async function stateFetch(creds, path, { method = "GET", body } = {}) {
  const res = await fetch(String(creds.url).replace(/\/+$/, "") + path, {
    method,
    headers: {
      Authorization: `Bearer ${creds.authToken}`,
      "Content-Type": "application/json",
      // The state-store Worker answers 403 (error 1010) with no User-Agent.
      "User-Agent": UA,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`state store HTTP ${res.status} on ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fqn) {
    console.error("usage: node scripts/repair-alchemy-state.mjs --fqn <FQN> [--repoint <appId>] [--apply]");
    process.exit(2);
  }
  const creds = readStateStoreCreds({ homedir: homedir(), readFileSync, env: process.env });
  if (!creds) {
    console.error("no alchemy state-store credentials found — run `pnpm alchemy login` first.");
    process.exit(2);
  }
  const path = `/state/stacks/${args.stack}/stages/${args.stage}/resources/${args.fqn}`;
  const doc = await stateFetch(creds, path);
  const now = summarizeDoc(doc);

  console.log(`${args.fqn}: status=${now.status} applicationId=${now.applicationId}`);
  console.log(`  downstream=${JSON.stringify(now.downstream)} old=${now.hasOld ? "present" : "absent"}`);

  let live;
  const observed = await observeLiveApplication(now.applicationId);
  if (observed.error) {
    console.log(`  live check skipped: ${observed.error}`);
  } else if (observed.recorded) {
    console.log(`  the recorded application ${now.applicationId} IS live in Cloudflare`);
    live = { applicationId: observed.recorded.id, aud: observed.recorded.aud };
  } else {
    const domain = doc?.attr?.domain;
    const byDomain = observed.apps.find((a) => a.domain === domain);
    console.log(`  the recorded application ${now.applicationId} is NOT live in Cloudflare`);
    if (byDomain) {
      console.log(`  the live application on ${domain} is ${byDomain.id}`);
      live = { applicationId: byDomain.id, aud: byDomain.aud };
    }
  }

  const plan = planRepair({ doc, live, targetAppId: args.repoint });
  console.log("");
  console.log(formatPlan(plan, { fqn: args.fqn }));

  if (plan.refusals?.length || plan.action === "none") process.exit(plan.refusals?.length ? 1 : 0);

  const repaired = applyPlanToDoc(doc, plan);
  const problems = assertSafeToWrite(doc, repaired);
  if (problems.length > 0) {
    console.error("");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  if (!args.apply) {
    console.log("\ndry run — nothing written. Re-run with --apply to write.");
    return;
  }

  const backup = `/tmp/alchemy-state-${args.fqn}-${Date.now()}.backup.json`;
  writeFileSync(backup, JSON.stringify(doc, null, 2));
  console.log(`\nbackup written: ${backup}`);
  await stateFetch(creds, path, { method: "PUT", body: repaired });
  console.log("written. Re-run `node scripts/selfhost-deploy-preflight.mjs` to confirm.");
}

// Only run when invoked directly, so the pure functions above stay importable.
if (process.argv[1] && process.argv[1].endsWith("repair-alchemy-state.mjs")) {
  main().catch((err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  });
}
