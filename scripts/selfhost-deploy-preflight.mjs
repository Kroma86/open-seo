// Fast checks before `pnpm deploy:selfhost` spends minutes on the build — a
// missing env value or Cloudflare login should fail in seconds instead.
// (Distinct from scripts/selfhost-preflight.ts, the Docker container-start
// preflight that validates the runtime environment.)
// Everything here is best-effort duplication of errors alchemy would raise
// later anyway; when in doubt (unreadable profile, API-token auth) it stays
// quiet and lets the deploy be the judge.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import chalk from "chalk";

const cmd = chalk.cyan;
const em = chalk.yellow;

const fail = (...lines) => {
  console.error(`\n${chalk.red("deploy:selfhost preflight failed:")}\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error("");
  process.exit(1);
};

// The `alchemy` script needs --experimental-strip-types (Node 22.6+).
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  fail(
    `Node ${em(process.versions.node)} is too old — the deploy needs Node 22.6 or newer (24 LTS recommended).`,
  );
}

const envFile = ".env.selfhost";
if (!existsSync(envFile)) {
  fail(
    `${em(envFile)} not found — create it first:`,
    "",
    `  ${cmd("cp .env.selfhost.example .env.selfhost")}`,
    "",
    `then set ${em("DATAFORSEO_API_KEY")} and ${em("ACCESS_ALLOWED_EMAILS")}.`,
  );
}
const env = {};
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (match) env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
}
if (!env.DATAFORSEO_API_KEY) {
  fail(
    `${em("DATAFORSEO_API_KEY")} is not set in ${envFile} — see docs/DATAFORSEO_API_KEY.md for how to get one.`,
  );
}
// When both are set, the deploy provisions no Access resources (hand-managed
// application) and needs neither ACCESS_ALLOWED_EMAILS nor the access:write
// login scope.
const managedAccess = !(env.TEAM_DOMAIN && env.POLICY_AUD);
if (managedAccess && !env.ACCESS_ALLOWED_EMAILS) {
  fail(
    `${em("ACCESS_ALLOWED_EMAILS")} is not set in ${envFile} — list who may sign in through`,
    "Cloudflare Access (comma-separated emails), or set TEAM_DOMAIN and POLICY_AUD",
    "to manage the Access application yourself.",
  );
}

// An explicit API token bypasses login profiles entirely.
if (!process.env.CLOUDFLARE_API_TOKEN) {
  const profileName = process.env.ALCHEMY_PROFILE || "default";
  let cloudflare;
  try {
    cloudflare = JSON.parse(
      readFileSync(path.join(homedir(), ".alchemy", "profiles.json"), "utf8"),
    ).profiles?.[profileName]?.Cloudflare;
  } catch {
    cloudflare = undefined;
  }
  if (!cloudflare) {
    fail(
      `No Cloudflare login found (alchemy profile "${profileName}") — run ${cmd("pnpm alchemy login")}`,
      `first (answer yes to "Customize OAuth scopes?" and enable ${em("access:write")}).`,
    );
  }
  if (
    managedAccess &&
    cloudflare.method === "oauth" &&
    Array.isArray(cloudflare.scopes) &&
    !cloudflare.scopes.includes("access:write")
  ) {
    fail(
      `Your Cloudflare login is missing the ${em("access:write")} scope, which the deploy needs`,
      "to provision the Cloudflare Access login gate. Log in again with the scope enabled:",
      "",
      `  ${cmd("pnpm alchemy login --configure")}`,
      "",
      `When asked "Customize OAuth scopes?", answer yes, then select ${em("access:write")}`,
      "(space to toggle, enter to confirm — keep the preselected defaults).",
    );
  }
}

// 2026-09-21: the machine-identity /mcp path (c5271d6) was deployed on Sep 16
// and then overwritten on Sep 17 by a deploy from a branch that forked before
// the merge. Grok Bot lost its MCP for four days and nobody could see why.
// Refuse to deploy any tree that does not carry it. This is a source check,
// not a git check, so it also holds in detached worktrees.
{
  const identityFile = "src/middleware/ensure-user/serviceTokenIdentity.ts";
  const serverTs = "src/server.ts";
  const hasFile = existsSync(identityFile);
  const wired =
    existsSync(serverTs) &&
    readFileSync(serverTs, "utf8").includes("resolveServiceTokenWorkspaceContext");
  if (!hasFile || !wired) {
    fail(
      `This tree does not carry the /mcp service-token identity fix (open-seo c5271d6 / a0665ec).`,
      `Missing: ${[!hasFile && identityFile, !wired && `${serverTs} -> resolveServiceTokenWorkspaceContext`].filter(Boolean).join(", ")}`,
      `Deploying it would break Grok Bot and Claude's OpenSEO MCP again (401 invalid_token, 0 tools).`,
      `Merge agency-platform (or cherry-pick a0665ec) into this line first.`,
    );
  }
}
