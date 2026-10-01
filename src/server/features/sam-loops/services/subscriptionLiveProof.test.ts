import { readFileSync, writeFileSync } from "node:fs";
import { jsonSchema } from "ai";
import { expect, it, vi } from "vitest";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";

const mocks = vi.hoisted(() => ({ project: vi.fn(), tools: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("../repositories/SamLoopRepository", () => ({ SamLoopRepository: {} }));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectById: mocks.project },
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {},
}));
vi.mock(
  "@/server/features/project-context/services/ProjectContextService",
  () => ({
    ProjectContextService: {
      getProjectContext: async () => ({ missingSections: [] }),
      renderProjectContextMarkdown: () => "",
    },
  }),
);
vi.mock("@/server/features/sam/samChatTools", () => ({
  buildSamMcpTools: mocks.tools,
}));
vi.mock("@/server/lib/openrouter", () => ({
  getChatAgentModel: () => {
    throw new Error("Model API calls forbidden in proof");
  },
}));
vi.mock("@/server/lib/chatAgent", () => ({ openRouterCostUsd: () => 0 }));
import { prepareSamLoop } from "./runHeadlessSamLoop";
import { buildSubscriptionPrompt } from "./subscriptionSamLoops";
import { validateSubscriptionFinal } from "./subscriptionContract";

it("builds the native runner contract with the shared prompt and no model API", async () => {
  const sourcePath = process.env.SAM_GROK_READ_ONLY_SOURCE;
  const source = sourcePath
    ? JSON.parse(readFileSync(sourcePath, "utf8"))
    : {
        project: {
          id: "22222222-2222-4222-8222-222222222222",
          name: "House",
          domain: "niceseo.ai",
          locationCode: 2124,
          languageCode: "en",
          loopsEnabled: false,
        },
        loop: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Keyword portfolio",
          sourceType: "custom",
          skillName: null,
          customPrompt: DEFAULT_SAM_LOOP_TEMPLATES.find(
            (loop) => loop.name === "Keyword portfolio",
          )!.customPrompt,
          nextRunAt: "2026-10-01T00:00:00.000Z",
        },
        tools: [
          {
            name: "list_saved_keywords",
            description: "Saved keywords",
            inputSchema: {
              type: "object",
              properties: { projectId: { type: "string" } },
              required: ["projectId"],
              additionalProperties: false,
            },
          },
        ],
        evidence: [],
      };
  expect(source.project.domain).toBe("niceseo.ai");
  expect(source.loop.customPrompt).toBe(
    DEFAULT_SAM_LOOP_TEMPLATES.find(
      (loop) => loop.name === "Keyword portfolio",
    )!.customPrompt,
  );
  mocks.project.mockResolvedValue({ ...source.project, archivedAt: null });
  mocks.tools.mockReturnValue(
    Object.fromEntries(
      source.tools.map(
        (entry: {
          name: string;
          description: string;
          inputSchema: Exclude<
            Parameters<typeof jsonSchema>[0],
            PromiseLike<unknown> | (() => unknown)
          >;
        }) => {
          const { projectId: unusedProjectId, ...properties } =
            entry.inputSchema.properties ?? {};
          return [
            entry.name,
            {
              description: entry.description,
              inputSchema: jsonSchema({
                ...entry.inputSchema,
                properties,
                required: (entry.inputSchema.required ?? []).filter(
                  (name) => name !== "projectId",
                ),
              }),
            },
          ];
        },
      ),
    ),
  );
  const prepared = await prepareSamLoop({
    project: source.project,
    sourceType: source.loop.sourceType,
    skillName: source.loop.skillName,
    customPrompt: source.loop.customPrompt,
    loopName: source.loop.name,
    authContext: {
      userId: "system",
      userEmail: "system@openseo.so",
      organizationId: "fixture",
      scopes: [],
      clientId: null,
      baseUrl: "https://seo.niceseo.ai",
    },
  });
  expect(prepared).toHaveProperty("tools");
  if (!("tools" in prepared)) throw new Error("Proof preparation refused");
  const preview = await buildSubscriptionPrompt(prepared);
  expect(preview.prompt).toContain("Keyword portfolio");
  expect(preview.outputSchema).toHaveProperty("oneOf");
  expect(
    preview.tools.some((tool) => tool.name === "get_business_reviews"),
  ).toBe(false);
  const outputPath = process.env.SAM_GROK_READ_ONLY_PREVIEW;
  const resultPath = process.env.SAM_GROK_READ_ONLY_RESULT;
  if (resultPath) {
    const proof = JSON.parse(readFileSync(resultPath, "utf8"));
    const checked = await validateSubscriptionFinal(
      proof.result,
      prepared.monthly,
      [],
      prepared.domain,
    );
    expect(checked.status).toBe("completed");
    expect(checked.error).toBeNull();
    expect(proof.reportPosted).toBe(false);
    expect(proof.toolPosts).toBe(0);
  }
  if (outputPath)
    writeFileSync(
      outputPath,
      JSON.stringify(
        {
          ...preview,
          loop: {
            id: source.loop.id,
            projectId: source.project.id,
            name: source.loop.name,
            scheduledFor: source.loop.nextRunAt,
          },
          evidence: source.evidence,
          checkedAt: source.checkedAt,
          contextOmitted:
            "Private project context withheld; shared prompt helper and public template used unchanged.",
          recentStatuses: source.recentStatuses,
        },
        null,
        2,
      ),
    );
});
