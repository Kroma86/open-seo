// Detect alchemy state that a previous deploy left half-written.
//
// Why this exists (NIC-775, 2026-09-17): the `SelfHostMcpAccess` state document
// sat at status "updating" holding an Access application id that no longer
// existed in Cloudflare. Alchemy observes an Access application by id, misses,
// falls back to a domain scan, finds the live app but marks it `Unowned`
// (Access applications carry no alchemy marker, so takeover is gated behind
// `--adopt`), and therefore plans a `create` — which Cloudflare answers with
// `application_already_exists`. Every deploy exited 1 until the state document
// was repaired by hand. The failure text named neither the stale id nor the
// live one, so it cost hours to read.
//
// An unsettled status is the fingerprint of a deploy that was killed partway
// through (a tool timeout, a closed laptop, a Ctrl-C). It is cheap to look for
// and it is the earliest point at which the problem is legible.
//
// Terminal statuses between deploys are created | updated | replaced. The
// others (creating, updating, deleting, replacing) mean a reconcile started and
// never finished.

export const SETTLED_STATUSES = Object.freeze(["created", "updated", "replaced"]);

const settled = new Set(SETTLED_STATUSES);

/** Resources whose status shows an unfinished reconcile. Pure. */
export function findUnsettled(resources) {
  if (!Array.isArray(resources)) return [];
  return resources.filter((r) => !settled.has(r?.status));
}

/** Operator-facing explanation of an unsettled state document. Pure. */
export function formatUnsettledFailure(unsettled, { stack, stage } = {}) {
  const lines = [
    `Alchemy state for ${stack}/${stage} has ${unsettled.length} resource(s) left mid-reconcile:`,
    "",
  ];
  for (const r of unsettled) {
    lines.push(`  ${r.fqn}: status=${r.status}`);
  }
  lines.push(
    "",
    "A previous deploy was interrupted before it finished writing state. Deploying now",
    "will most likely fail with a Cloudflare conflict (for Access applications:",
    "`application_already_exists`), because state points at a resource that may no",
    "longer exist while the real one is still live.",
    "",
    "Before deploying, reconcile the state document with what is actually live —",
    "see \"Alchemy state drift\" in docs/SELF_HOSTING_CLOUDFLARE_OPERATIONS.md.",
  );
  return lines.join("\n");
}

/** Read the state-store URL and token alchemy wrote at login. Never throws. */
export function readStateStoreCreds({ homedir, readFileSync, env = {} } = {}) {
  if (env.ALCHEMY_STATE_URL && env.ALCHEMY_STATE_TOKEN) {
    return { url: env.ALCHEMY_STATE_URL, authToken: env.ALCHEMY_STATE_TOKEN };
  }
  const profile = env.ALCHEMY_PROFILE || "default";
  try {
    const raw = readFileSync(
      `${homedir}/.alchemy/credentials/${profile}/cloudflare-state-store.json`,
      "utf8",
    );
    const parsed = JSON.parse(raw);
    return parsed?.url && parsed?.authToken ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch each resource's status for one stack/stage.
 * Returns undefined (caller stays quiet) when the store cannot be reached —
 * this is a preflight convenience, never a gate on its own availability.
 */
export async function fetchResourceStates(
  { url, authToken, stack, stage },
  { fetchImpl = fetch, timeoutMs = 8000 } = {},
) {
  const base = String(url).replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${authToken}`,
    // The state-store Worker answers 403 (error 1010) without a User-Agent.
    "User-Agent": "open-seo-deploy-preflight/1.0",
  };
  const get = async (path) => {
    const res = await fetchImpl(base + path, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  };
  try {
    const listed = await get(`/state/stacks/${stack}/stages/${stage}/resources`);
    const fqns = (Array.isArray(listed) ? listed : (listed?.resources ?? [])).map(
      (r) => (typeof r === "string" ? r : r?.fqn),
    );
    const docs = await Promise.all(
      fqns.filter(Boolean).map(async (fqn) => {
        const doc = await get(
          `/state/stacks/${stack}/stages/${stage}/resources/${fqn}`,
        );
        return { fqn, status: doc?.status };
      }),
    );
    return docs;
  } catch {
    return undefined;
  }
}

/**
 * Whole check. Resolves to one of:
 *   { outcome: "skipped" }               nothing readable — say nothing
 *   { outcome: "ok", checked: n }        every resource settled
 *   { outcome: "unsettled", message }    deploy should stop
 */
export async function checkStateSettled(
  { stack, stage },
  { homedir, readFileSync, env = {}, fetchImpl = fetch } = {},
) {
  const creds = readStateStoreCreds({ homedir, readFileSync, env });
  if (!creds) return { outcome: "skipped" };
  const resources = await fetchResourceStates(
    { ...creds, stack, stage },
    { fetchImpl },
  );
  if (!resources || resources.length === 0) return { outcome: "skipped" };
  const unsettled = findUnsettled(resources);
  if (unsettled.length === 0) {
    return { outcome: "ok", checked: resources.length };
  }
  return {
    outcome: "unsettled",
    message: formatUnsettledFailure(unsettled, { stack, stage }),
    unsettled,
  };
}
