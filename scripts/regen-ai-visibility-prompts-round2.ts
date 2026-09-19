/**
 * Round two: the five clients round one left out because their stored location
 * disagreed with their Google profile, or had no location at all.
 *
 * Corryn answered each on 19 Sep 2026 (Slack DM):
 *   Play 2 Learn 4 Life  "They have locations in Vernon and Vancouver."
 *   Jace-Xteriors        "They are in Lake Country, service the Okanagan."
 *   Daysdream            "They can't get a Google business profile, so state Spallumcheen."
 *   Lyndsy Pahl          "Based out of Vernon, servicing all of BC and Alberta. She is an individual."
 *   NiceApp              "Vernon only."
 *
 * Her answer on Lyndsy also settles the brand question: the registered brand
 * stays "Lyndsy Pahl" rather than a brokerage name. Only Vernon prompts are
 * built — province-wide prompts would measure a field she cannot place in.
 */
import { randomUUID } from "node:crypto";

import {
  type BusinessKind,
  buildAiVisibilityPrompts,
} from "../src/server/features/ai-visibility/services/promptSuggestions";

type Location = { city: string; region: string; limit?: number };

type Client = {
  site: string;
  configId: string;
  category: string;
  kind?: BusinessKind;
  locations: Location[];
  note: string;
};

const CLIENTS: Client[] = [
  {
    site: "jacexteriors.net",
    configId: "d852d263-1b6f-4301-acf4-7be6ca658e49",
    category: "Siding contractor",
    locations: [{ city: "Lake Country", region: "British Columbia" }],
    note: "Corryn: in Lake Country, services the Okanagan",
  },
  {
    site: "daysdream.ca",
    configId: "3916eb33-5d5d-4b68-856b-fe99f1cd95db",
    category: "Facial spa",
    kind: "choose",
    locations: [{ city: "Spallumcheen", region: "British Columbia" }],
    note: "Corryn: cannot get a Google Business Profile, so state Spallumcheen",
  },
  {
    site: "mortgagewithlyndsy.com",
    configId: "b497d634-3f25-4d4f-a5b4-ae4de8b4d7a2",
    category: "Mortgage broker",
    locations: [{ city: "Vernon", region: "British Columbia" }],
    note: "Corryn: based out of Vernon, servicing all of BC and Alberta; she is an individual",
  },
  {
    site: "Niceapp",
    configId: "cfbc9b9f-7cf4-4150-8cc8-20e935ee2f87",
    category: "Software company",
    locations: [{ city: "Vernon", region: "British Columbia" }],
    note: "Corryn: Vernon only. Google had Waterloo. Kept distinct from TWA Studio's 'marketing agency' so our own two brands do not compete for one prompt set",
  },
  {
    site: "play2learn4life.com",
    configId: "7c2d73c7-368f-41bf-a7dc-94c7dfc47a5e",
    category: "Pediatric occupational therapist",
    kind: "choose",
    locations: [
      { city: "Vernon", region: "British Columbia", limit: 5 },
      { city: "Vancouver", region: "British Columbia", limit: 5 },
    ],
    note: "Corryn: locations in both Vernon and Vancouver, so the 10-prompt cap splits 5/5",
  },
];

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const rows: string[] = [];
for (const c of CLIENTS) {
  const prompts = c.locations.flatMap((loc) =>
    buildAiVisibilityPrompts({
      category: c.category,
      kind: c.kind,
      city: loc.city,
      region: loc.region,
      limit: loc.limit,
    }),
  );
  console.error(`# ${c.site} [${c.kind ?? "hire"}] (${prompts.length})`);
  for (const p of prompts) {
    console.error(`    ${p}`);
    rows.push(`(${q(randomUUID())}, ${q(c.configId)}, ${q(p)}, 1)`);
  }
}

const ids = CLIENTS.map((c) => q(c.configId)).join(", ");
console.log(`-- ${CLIENTS.length} configs, ${rows.length} prompts`);
console.log(`DELETE FROM ai_visibility_prompts WHERE config_id IN (${ids});`);
console.log(
  `INSERT INTO ai_visibility_prompts (id, config_id, prompt, is_active) VALUES\n${rows.join(",\n")};`,
);
console.log(
  `UPDATE ai_visibility_configs SET prompt_set_version = prompt_set_version + 1 WHERE id IN (${ids});`,
);
