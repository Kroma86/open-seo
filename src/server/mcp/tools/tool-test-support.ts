import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { ToolAuthContext, ToolContext } from "@/server/mcp/context";

export function makeToolContext(
  overrides: Partial<ToolAuthContext> = {},
): ToolContext {
  return {
    auth: {
      userId: "user_123",
      userEmail: "alice@example.com",
      organizationId: "org_123",
      clientId: "client_123",
      scopes: ["mcp"],
      baseUrl: "https://open-seo.test",
      ...overrides,
    },
  };
}

export function textContent(result: {
  content?: Array<{ type: string; text?: string }>;
}) {
  const first = result.content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

/**
 * Validates a handler payload the way an MCP client does: the server publishes
 * the output schema through toJsonSchemaCompat (additionalProperties:false) and
 * the client checks structuredContent against it. `z.object(shape).safeParse`
 * is NOT equivalent -- zod strips unknown keys, so undeclared fields pass.
 */
export function validateAsClientWould(
  outputSchema: Parameters<typeof normalizeObjectSchema>[0],
  payload: unknown,
) {
  const normalized = normalizeObjectSchema(outputSchema);
  if (!normalized) throw new Error("outputSchema is not an object schema");
  const published = toJsonSchemaCompat(normalized, {
    strictUnions: true,
    pipeStrategy: "output",
  });
  return new AjvJsonSchemaValidator().getValidator(published)(payload);
}
