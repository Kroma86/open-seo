/** Read-only enumeration of every proposal key, independent of the recent-ID index. */
import { env } from "cloudflare:workers";
import { proposalPayloadHash } from "./ProposalRejectionService";
import { ProposalRejectionsRepository } from "./repositories/ProposalRejectionsRepository";

const PREFIX = "homegrown-otto:proposal:";
const PAGE_SIZE = 100;
const MAX_RECORD_BYTES = 65536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ProposalInventoryError extends Error {
  constructor(public readonly status: 400 | 503 = 503) {
    super(
      status === 400
        ? "invalid_inventory_request"
        : "proposal_inventory_unavailable",
    );
  }
}

function check(ok: unknown): asserts ok {
  if (!ok) throw new ProposalInventoryError();
}

async function readBounded(key: string): Promise<string> {
  const stream = await env.KV.get(key, { type: "stream" });
  check(stream);
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      check(bytes <= MAX_RECORD_BYTES);
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function digest(text: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function readProposalInventoryPage(cursor: string | null) {
  if (
    cursor !== null &&
    (!cursor || cursor.length > 4096 || /[\x00-\x20\x7f]/.test(cursor))
  )
    throw new ProposalInventoryError(400);
  const started = new Date().toISOString();
  const page = await env.KV.list({
    prefix: PREFIX,
    limit: PAGE_SIZE,
    ...(cursor === null ? {} : { cursor }),
  });
  check(
    Array.isArray(page.keys) &&
      page.keys.length <= PAGE_SIZE &&
      typeof page.list_complete === "boolean",
  );
  const next = page.list_complete
    ? null
    : "cursor" in page
      ? page.cursor
      : null;
  check(
    page.list_complete ||
      (typeof next === "string" &&
        next.length > 0 &&
        next.length <= 4096 &&
        next !== cursor &&
        !/[\x00-\x20\x7f]/.test(next)),
  );
  const ids = page.keys.map((key) => {
    check(typeof key.name === "string" && key.name.startsWith(PREFIX));
    const id = key.name.slice(PREFIX.length);
    check(UUID.test(id));
    return id;
  });
  check(ids.every((id, index) => index === 0 || ids[index - 1] < id));
  const records = [];
  for (let offset = 0; offset < ids.length; offset += 25) {
    const batch = ids.slice(offset, offset + 25);
    const texts = await Promise.all(
      batch.map((id) => readBounded(PREFIX + id)),
    );
    const rejectionRows = await ProposalRejectionsRepository.findByIds(batch);
    const rejected = new Map(rejectionRows.map((row) => [row.proposalId, row]));
    check(
      rejected.size === rejectionRows.length &&
        [...rejected.keys()].every((id) => batch.includes(id)),
    );
    for (const [index, text] of texts.entries()) {
      const raw: unknown = JSON.parse(text);
      check(raw && typeof raw === "object" && !Array.isArray(raw));
      const row = raw as Record<string, unknown>;
      check(
        row.id === batch[index] &&
          typeof row.domain === "string" &&
          row.domain.length <= 253 &&
          /^[a-z0-9.-]+\.[a-z]{2,}$/.test(row.domain) &&
          typeof row.path === "string" &&
          row.path.startsWith("/") &&
          !row.path.startsWith("//") &&
          row.path.length <= 2048 &&
          !/[\x00-\x1f\x7f]/.test(row.path) &&
          ["pending", "pulled", "rejected"].includes(String(row.status)),
      );
      check(
        row.fixes && typeof row.fixes === "object" && !Array.isArray(row.fixes),
      );
      const fixes = row.fixes as Record<string, unknown>;
      const fields = Object.keys(fixes).sort();
      check(
        fields.length > 0 &&
          fields.length <= 100 &&
          fields.every(
            (field) =>
              field.length > 0 &&
              field.length <= 128 &&
              !/[\x00-\x1f\x7f]/.test(field) &&
              typeof fixes[field] === "string" &&
              (fixes[field] as string).trim(),
          ),
      );
      const payloadHash = await proposalPayloadHash(row);
      const rejection = rejected.get(batch[index]);
      if (rejection)
        check(
          rejection.payloadHash === payloadHash &&
            rejection.domain === row.domain &&
            rejection.path === row.path &&
            UUID.test(rejection.requestId),
        );
      records.push({
        id: row.id as string,
        domain: row.domain as string,
        path: row.path as string,
        fields,
        status: rejection
          ? "rejected"
          : (row.status as "pending" | "pulled" | "rejected"),
        payload_hash: payloadHash,
        record_hash: await digest(text),
        rejection_request_id: rejection?.requestId ?? null,
      });
    }
  }
  return {
    schema: "otto-inventory-page/1",
    scope: "all_proposal_keys",
    consistency: "eventual_not_atomic",
    request_cursor: cursor,
    next_cursor: next,
    list_complete: page.list_complete,
    count: records.length,
    records,
    read_started_at: started,
    read_finished_at: new Date().toISOString(),
  };
}
