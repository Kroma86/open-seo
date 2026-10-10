/**
 * Round three: fill each client's spare prompt slots with SERVICE prompts.
 *
 * Why: B-Line's first honest run (19 Sep, 3 of 9) was won on service prompts.
 * "Who offers panel upgrades in Woodstock, Ontario?" and "who offers generator
 * installation" both named the brand; all six generic "best electricians"
 * prompts returned nothing. A small local business cannot out-rank a whole
 * city's trade, but it can own a service.
 *
 * Every service below is taken from that client's OWN words — their business
 * description, their stated niche, or their Google Business Profile categories.
 * Nothing here is invented. Two clients are skipped because their copy names no
 * service at all: ingersolllanes.ca and mortgagewithlyndsy.com.
 *
 * This round only ADDS. The six stock prompts already live stay untouched, so
 * each client ends at 6 + up to 4 = the 10-prompt cap.
 */
import { randomUUID } from "node:crypto";

import {
  type BusinessKind,
  buildAiVisibilityPrompts,
} from "../src/server/features/ai-visibility/services/promptSuggestions";

type Client = {
  site: string;
  configId: string;
  category: string;
  kind?: BusinessKind;
  city: string;
  region: string;
  services: string[];
};

const CLIENTS: Client[] = [
  { site: "abbeylawcorporation.com", configId: "ca9daf33-fbbd-484b-856e-0bd3fb2de030", category: "Law firm", city: "Armstrong", region: "British Columbia", services: ["estate planning", "family law", "real estate law", "notary services"] },
  { site: "alsappliance.ca", configId: "3fd5a535-08d6-4c4a-81ea-e20bfc88fb87", category: "Appliance repair service", city: "Kitchener", region: "Ontario", services: ["in-home appliance repair", "same-day appliance repair", "used appliance sales", "appliance delivery"] },
  { site: "cinnamoncounselling.ca", configId: "8df61d7c-90eb-4301-8b91-ed47572f0fa4", kind: "choose", category: "Couples counsellor", city: "Vancouver", region: "British Columbia", services: ["couples counselling", "marriage therapy", "affair recovery", "trauma-informed counselling"] },
  { site: "coachburke.ca", configId: "7604dc80-e463-4f99-b3c4-ce61c20c414f", category: "Life coach", city: "Kelowna", region: "British Columbia", services: ["mental performance coaching", "coaching for teens", "coaching for men"] },
  { site: "coachingwithkym.com", configId: "fd7ffb31-38a0-4fbd-93d8-e05f8559211e", category: "Weight loss service", city: "Kelowna", region: "British Columbia", services: ["weight loss coaching", "accountability coaching", "coaching for women over 40"] },
  { site: "culturalambassadorvernon.ca", configId: "8483624c-b529-41c4-b590-1294b94163c9", category: "Business management consultant", city: "Enderby", region: "British Columbia", services: ["DEI consulting", "Indigenous advisory", "cultural ambassadorship"] },
  { site: "daysdream.ca", configId: "3916eb33-5d5d-4b68-856b-fe99f1cd95db", kind: "choose", category: "Facial spa", city: "Spallumcheen", region: "British Columbia", services: ["facials", "reiki", "skin care treatments", "aromatherapy"] },
  { site: "ecliptechplumbing.ca", configId: "3da92c63-8057-4c52-aa55-42f7dfc9be4d", category: "Plumber", city: "Vernon", region: "British Columbia", services: ["plumbing repairs", "water treatment", "flood prevention systems", "custom plumbing installations"] },
  { site: "fenskefinancialcoaching.com", configId: "928fa879-7d4b-4458-9be9-397aa59cd700", category: "Financial consultant", city: "Vernon", region: "British Columbia", services: ["financial coaching", "personal finance management", "financial planning"] },
  { site: "greenawaytheisassociates.ca", configId: "b63634fa-f7d1-4b44-bc7e-5305c5154879", kind: "choose", category: "Psychologist", city: "Guelph", region: "Ontario", services: ["couples therapy", "family therapy", "trauma recovery", "psychological assessments"] },
  { site: "haulitforward.ca", configId: "811920fd-eb0b-4e64-a3d1-279660d206ea", category: "Lawn care service", city: "Tillsonburg", region: "Ontario", services: ["snow removal", "junk removal", "property maintenance", "seasonal cleanup"] },
  { site: "homecaresolutions.ca", configId: "0a8585a6-032a-4e5f-aee9-3a0067588794", category: "House cleaning service", city: "Vernon", region: "British Columbia", services: ["deep cleaning", "Airbnb turnover cleaning", "move-out cleaning", "recurring house cleaning"] },
  { site: "jacexteriors.net", configId: "d852d263-1b6f-4301-acf4-7be6ca658e49", category: "Siding contractor", city: "Lake Country", region: "British Columbia", services: ["siding installation", "stucco", "roofing", "insulation"] },
  { site: "kleanco.ca", configId: "cb01f297-2616-45f8-893e-2710c9019fdb", category: "House cleaning service", city: "Lumby", region: "British Columbia", services: ["residential cleaning", "commercial cleaning", "office cleaning"] },
  { site: "littleleafhaven.com", configId: "bfb48a3a-c7b2-4ee4-ad7f-131e0953745d", kind: "choose", category: "Florist", city: "Ingersoll", region: "Ontario", services: ["wedding flowers", "flower delivery", "event flowers", "tropical plants"] },
  { site: "lymphfinity.com", configId: "69c00e01-a7c0-4f28-88ef-92606427ec84", kind: "choose", category: "Wellness center", city: "Vernon", region: "British Columbia", services: ["lymphatic enhancement", "natural detox", "pain relief"] },
  { site: "millcreekbakery.ca", configId: "18a2ad76-2ee9-4377-b05e-25001a1b9883", kind: "choose", category: "Bakery", city: "Kelowna", region: "British Columbia", services: ["fresh bread", "cakes", "pastries"] },
  { site: "newbeginningscounsellingservice.com", configId: "b365a379-5fdc-4aa2-9fc2-6039a1aa329e", kind: "choose", category: "Counsellor", city: "Salmon Arm", region: "British Columbia", services: ["anxiety counselling", "grief counselling", "trauma counselling", "chronic pain counselling"] },
  { site: "Niceapp", configId: "cfbc9b9f-7cf4-4150-8cc8-20e935ee2f87", category: "Software company", city: "Vernon", region: "British Columbia", services: ["AI voice agents", "CRM automation", "automated follow-ups"] },
  { site: "onindustrialcoatings.com", configId: "0d922e68-1846-4af4-8e26-75dcd24ca4b2", category: "Auto body shop", city: "Woodstock", region: "Ontario", services: ["fleet rebranding", "truck painting", "powder coating", "sandblasting"] },
  { site: "pepperichpizza.com", configId: "c3e5d811-0fa6-4e97-82b8-38ecd5f0fb45", kind: "choose", category: "Pizza restaurant", city: "Vernon", region: "British Columbia", services: ["butter chicken pizza", "ghost pepper pizza", "tandoori chicken pizza"] },
  { site: "primerrustrosesphotography.com", configId: "993d5cbc-9bcb-41e1-9da1-bb014abe9cc4", category: "Photographer", city: "Armstrong", region: "British Columbia", services: ["family photography", "engagement photography", "newborn photography", "headshots"] },
  { site: "setantalandscapes.ca", configId: "4ad515fa-15f6-4fb2-853d-f347e50a94e1", category: "Landscaper", city: "Vernon", region: "British Columbia", services: ["landscape design", "landscape construction", "fencing", "lawn care"] },
  { site: "ssocc.ca", configId: "80cc2573-f395-458b-929f-b14185451e27", kind: "choose", category: "Child care agency", city: "Richmond", region: "British Columbia", services: ["Reggio-inspired childcare", "nature-based early learning"] },
  { site: "sweetbeesbaskets.ca", configId: "1e8080d4-9237-44a1-a1a9-1fadcd2741aa", kind: "choose", category: "Gift basket store", city: "Lake Country", region: "British Columbia", services: ["handcrafted gift baskets", "local artisan gift baskets"] },
  { site: "truewoodstimber.com", configId: "228b2ea8-9e41-4581-a190-088c4cb8aa9e", kind: "choose", category: "Furniture store", city: "Stony Plain", region: "Alberta", services: ["custom furniture", "architectural millwork", "bespoke woodworking"] },
  { site: "twa.studio", configId: "b28afed6-b68c-4a4c-b5c2-a8bf85f8bfbd", category: "Marketing agency", city: "Vernon", region: "British Columbia", services: ["web design", "local SEO", "Google Business Profile optimization", "CRM automation"] },
  { site: "tynebuchyrcc.com", configId: "cf3f1831-95a7-40e7-b6ee-17e7b61daeb4", kind: "choose", category: "Counsellor", city: "Vernon", region: "British Columbia", services: ["EMDR therapy", "couples counselling", "group therapy", "clinical supervision"] },
  { site: "vanyalaporte.com", configId: "d53e113c-c3c4-46d4-b039-3cd1c723557f", kind: "choose", category: "Counsellor", city: "Victoria", region: "British Columbia", services: ["somatic therapy", "nature-based therapy", "trauma therapy", "clinical supervision"] },
  { site: "vernonflowers.ca", configId: "76473c43-068d-4a1a-b7ff-b4f91d2b25d4", kind: "choose", category: "Florist", city: "Vernon", region: "British Columbia", services: ["flower delivery", "gift baskets", "local artisan gifts"] },
  { site: "veruminnovations.com", configId: "853ebfd9-7f5b-4566-a8a6-bf9c50c0c312", category: "Contractor", city: "Vernon", region: "British Columbia", services: ["kitchen renovations", "bathroom renovations", "home remodels", "outdoor living renovations"] },
  { site: "wellhealthcounselling.com", configId: "0cd6072a-adb4-408d-97a3-a0e174e846cc", kind: "choose", category: "Counsellor", city: "Vancouver", region: "British Columbia", services: ["ADHD assessment", "anxiety counselling", "trauma therapy", "couples counselling"] },
];

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const rows: string[] = [];
let over = 0;
for (const c of CLIENTS) {
  if (c.services.length > 4) {
    console.error(`!! ${c.site}: ${c.services.length} services, only 4 slots free`);
    over++;
  }
  // Build the full set with the tested generator, then keep only its service
  // lines. The six stock prompts are already live and are not touched.
  const all = buildAiVisibilityPrompts({
    category: c.category,
    kind: c.kind,
    city: c.city,
    region: c.region,
    services: c.services,
  });
  const servicePrompts = all.filter((p) => p.startsWith("Who offers "));
  if (servicePrompts.length !== c.services.length) {
    console.error(`!! ${c.site}: expected ${c.services.length} service prompts, got ${servicePrompts.length}`);
    over++;
  }
  console.error(`# ${c.site} (+${servicePrompts.length})`);
  for (const p of servicePrompts) {
    console.error(`    ${p}`);
    rows.push(`(${q(randomUUID())}, ${q(c.configId)}, ${q(p)}, 1)`);
  }
}
if (over > 0) {
  console.error(`REFUSING: ${over} problem(s) above`);
  process.exit(1);
}

const ids = CLIENTS.map((c) => q(c.configId)).join(", ");
console.log(`-- ${CLIENTS.length} configs, ${rows.length} service prompts (adds only)`);
console.log(
  `INSERT INTO ai_visibility_prompts (id, config_id, prompt, is_active) VALUES\n${rows.join(",\n")};`,
);
console.log(
  `UPDATE ai_visibility_configs SET prompt_set_version = prompt_set_version + 1 WHERE id IN (${ids});`,
);
