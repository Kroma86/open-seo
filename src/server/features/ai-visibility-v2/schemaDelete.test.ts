import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
it("does not block existing prompt deletion or project deletion", async () => {
  const client = createClient({ url: "file::memory:" });
  await client.execute("PRAGMA foreign_keys=ON");
  await client.execute("CREATE TABLE projects(id TEXT PRIMARY KEY)");
  await client.execute(
    "CREATE TABLE ai_visibility_configs(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE)",
  );
  await client.execute(
    "CREATE TABLE ai_visibility_prompts(id TEXT PRIMARY KEY)",
  );
  for (const statement of readFileSync(
    "drizzle/0047_measurement_v2.sql",
    "utf8",
  ).split("--> statement-breakpoint"))
    await client.execute(statement);
  await client.execute("INSERT INTO projects VALUES('project')");
  await client.execute(
    "INSERT INTO ai_visibility_configs VALUES('config','project')",
  );
  await client.execute("INSERT INTO ai_visibility_prompts VALUES('prompt')");
  await client.execute(
    "INSERT INTO measurement_enrollments(project_id,config_id,domain,context_hash,eligibility_evidence,eligibility_hash,verified_at,starts_at) VALUES('project','config','example.test','synthetic','synthetic','synthetic','synthetic','synthetic')",
  );
  await client.execute(
    "INSERT INTO measurement_questions(id,project_id,prompt_id,prompt,kind) VALUES('question','project','prompt','Synthetic?','active')",
  );
  await client.execute(
    "INSERT INTO measurement_runs(id,project_id,week,pilot_starts_at,brand,domain,config_id,status,answers,reserved_billed_credit_hundredths,created_at) VALUES('run','project','synthetic','synthetic','Example','example.test','config','posting',1,154,'synthetic')",
  );
  await client.execute(
    "INSERT INTO measurement_answers(id,run_id,prompt_id,prompt,engine,repeat,status) VALUES('answer','run','prompt','Synthetic?','chatgpt',1,'posted')",
  );
  await client.execute(
    "INSERT INTO measurement_citations VALUES('citation','answer','example.test')",
  );
  await client.execute("DELETE FROM ai_visibility_prompts WHERE id='prompt'");
  expect(
    (await client.execute("SELECT prompt FROM measurement_answers")).rows[0]
      .prompt,
  ).toBe("Synthetic?");
  await client.execute("DELETE FROM projects WHERE id='project'");
  for (const table of [
    "measurement_enrollments",
    "measurement_questions",
    "measurement_runs",
    "measurement_answers",
    "measurement_citations",
  ])
    expect(
      (await client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n,
    ).toBe(0);
  expect((await client.execute("PRAGMA foreign_key_check")).rows).toHaveLength(
    0,
  );
  client.close();
});
