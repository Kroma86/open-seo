/**
 * Regenerates the tracked AI-visibility prompt sets from the GBP primary
 * category plus the city AND province, and prints the SQL to apply it.
 *
 * Written 19 Sep 2026 after the audit found the shipped sets named a city
 * with no province: ChatGPT refused ("which Woodstock?") and Perplexity
 * answered about Woodstock, GEORGIA.
 *
 * Clients whose stored location disagrees with their Google profile, or whose
 * category is not on file, are NOT in this list — those need a human answer,
 * not a default. See DEFERRED at the bottom.
 */
import { randomUUID } from "node:crypto";

import {
  type BusinessKind,
  buildAiVisibilityPrompts,
} from "../src/server/features/ai-visibility/services/promptSuggestions";

type Client = {
  site: string;
  configId: string;
  /** GBP primary category, verbatim unless Google's label is not a phrase a
   *  customer would type — then the client's own word for themselves. */
  category: string;
  /** "choose" for a business you pick or visit rather than hire. */
  kind?: BusinessKind;
  city: string;
  region: string;
  note?: string;
};

const CLIENTS: Client[] = [
  { site: "abbeylawcorporation.com", configId: "ca9daf33-fbbd-484b-856e-0bd3fb2de030", category: "Law firm", city: "Armstrong", region: "British Columbia" },
  { site: "alsappliance.ca", configId: "3fd5a535-08d6-4c4a-81ea-e20bfc88fb87", category: "Appliance repair service", city: "Kitchener", region: "Ontario", note: "Corryn: Kitchener is the main location, Guelph stays for its reviews" },
  { site: "cinnamoncounselling.ca", configId: "8df61d7c-90eb-4301-8b91-ed47572f0fa4", kind: "choose", category: "Couples counsellor", city: "Vancouver", region: "British Columbia", note: "Google label is 'Marriage or relationship counselor'; site sells 'couples counselling in Vancouver'" },
  { site: "coachburke.ca", configId: "7604dc80-e463-4f99-b3c4-ce61c20c414f", category: "Life coach", city: "Kelowna", region: "British Columbia" },
  { site: "coachingwithkym.com", configId: "fd7ffb31-38a0-4fbd-93d8-e05f8559211e", category: "Weight loss service", city: "Kelowna", region: "British Columbia" },
  { site: "culturalambassadorvernon.ca", configId: "8483624c-b529-41c4-b590-1294b94163c9", category: "Business management consultant", city: "Enderby", region: "British Columbia" },
  { site: "ecliptechplumbing.ca", configId: "3da92c63-8057-4c52-aa55-42f7dfc9be4d", category: "Plumber", city: "Vernon", region: "British Columbia" },
  { site: "fenskefinancialcoaching.com", configId: "928fa879-7d4b-4458-9be9-397aa59cd700", category: "Financial consultant", city: "Vernon", region: "British Columbia" },
  { site: "greenawaytheisassociates.ca", configId: "b63634fa-f7d1-4b44-bc7e-5305c5154879", kind: "choose", category: "Psychologist", city: "Guelph", region: "Ontario", note: "no GBP section; category from their own 'psychological services across Guelph, Cambridge and Woodstock'" },
  { site: "haulitforward.ca", configId: "811920fd-eb0b-4e64-a3d1-279660d206ea", category: "Lawn care service", city: "Tillsonburg", region: "Ontario" },
  { site: "homecaresolutions.ca", configId: "0a8585a6-032a-4e5f-aee9-3a0067588794", category: "House cleaning service", city: "Vernon", region: "British Columbia" },
  { site: "ingersolllanes.ca", configId: "597916d8-f278-4a8c-ad18-2c0c6f6db3fd", kind: "choose", category: "Bowling club", city: "Ingersoll", region: "Ontario" },
  { site: "kleanco.ca", configId: "cb01f297-2616-45f8-893e-2710c9019fdb", category: "House cleaning service", city: "Lumby", region: "British Columbia" },
  { site: "littleleafhaven.com", configId: "bfb48a3a-c7b2-4ee4-ad7f-131e0953745d", kind: "choose", category: "Florist", city: "Ingersoll", region: "Ontario" },
  { site: "lymphfinity.com", configId: "69c00e01-a7c0-4f28-88ef-92606427ec84", kind: "choose", category: "Wellness center", city: "Vernon", region: "British Columbia" },
  { site: "millcreekbakery.ca", configId: "18a2ad76-2ee9-4377-b05e-25001a1b9883", kind: "choose", category: "Bakery", city: "Kelowna", region: "British Columbia" },
  { site: "newbeginningscounsellingservice.com", configId: "b365a379-5fdc-4aa2-9fc2-6039a1aa329e", kind: "choose", category: "Counsellor", city: "Salmon Arm", region: "British Columbia", note: "no GBP section; category from their own name and description" },
  { site: "onindustrialcoatings.com", configId: "0d922e68-1846-4af4-8e26-75dcd24ca4b2", category: "Auto body shop", city: "Woodstock", region: "Ontario" },
  { site: "pepperichpizza.com", configId: "c3e5d811-0fa6-4e97-82b8-38ecd5f0fb45", kind: "choose", category: "Pizza restaurant", city: "Vernon", region: "British Columbia" },
  { site: "primerrustrosesphotography.com", configId: "993d5cbc-9bcb-41e1-9da1-bb014abe9cc4", category: "Photographer", city: "Armstrong", region: "British Columbia" },
  { site: "setantalandscapes.ca", configId: "4ad515fa-15f6-4fb2-853d-f347e50a94e1", category: "Landscaper", city: "Vernon", region: "British Columbia" },
  { site: "ssocc.ca", configId: "80cc2573-f395-458b-929f-b14185451e27", kind: "choose", category: "Child care agency", city: "Richmond", region: "British Columbia", note: "Google address is the Port Coquitlam ADMIN office; the centre is in Richmond" },
  { site: "sweetbeesbaskets.ca", configId: "1e8080d4-9237-44a1-a1a9-1fadcd2741aa", kind: "choose", category: "Gift basket store", city: "Lake Country", region: "British Columbia" },
  { site: "truewoodstimber.com", configId: "228b2ea8-9e41-4581-a190-088c4cb8aa9e", kind: "choose", category: "Furniture store", city: "Stony Plain", region: "Alberta" },
  { site: "twa.studio", configId: "b28afed6-b68c-4a4c-b5c2-a8bf85f8bfbd", category: "Marketing agency", city: "Vernon", region: "British Columbia" },
  { site: "tynebuchyrcc.com", configId: "cf3f1831-95a7-40e7-b6ee-17e7b61daeb4", kind: "choose", category: "Counsellor", city: "Vernon", region: "British Columbia", note: "Google primary is 'Mental health service'; they call themselves a Counselling Collective" },
  { site: "vanyalaporte.com", configId: "d53e113c-c3c4-46d4-b039-3cd1c723557f", kind: "choose", category: "Counsellor", city: "Victoria", region: "British Columbia" },
  { site: "vernonflowers.ca", configId: "76473c43-068d-4a1a-b7ff-b4f91d2b25d4", kind: "choose", category: "Florist", city: "Vernon", region: "British Columbia" },
  { site: "veruminnovations.com", configId: "853ebfd9-7f5b-4566-a8a6-bf9c50c0c312", category: "Contractor", city: "Vernon", region: "British Columbia" },
  { site: "wellhealthcounselling.com", configId: "0cd6072a-adb4-408d-97a3-a0e174e846cc", kind: "choose", category: "Counsellor", city: "Vancouver", region: "British Columbia" },
];

/**
 * Left alone on purpose. Each needs a person to answer, not a default:
 *   mortgagewithlyndsy.com  no city on file at all; serves BC *and* Alberta
 *   play2learn4life.com     stored Vernon vs Google Vancouver (400 km apart)
 *   jacexteriors.net        stored Lumby vs Google Lake Country
 *   daysdream.ca            stored Armstrong vs Google Spallumcheen; NAP unresolved
 *   Niceapp / Default       the agency's own projects, not local clients
 */

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const rows: string[] = [];
for (const c of CLIENTS) {
  const prompts = buildAiVisibilityPrompts({
    category: c.category,
    kind: c.kind,
    city: c.city,
    region: c.region,
  });
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
