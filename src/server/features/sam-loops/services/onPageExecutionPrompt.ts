import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";

export function onPageExecutionPrompt(customPrompt: string): string {
  const onPageTemplate = DEFAULT_SAM_LOOP_TEMPLATES.find(
    (template) => template.name === "On-page priorities",
  );
  if (customPrompt !== onPageTemplate?.customPrompt) return customPrompt;
  // Preserve the reserved stored identity used to grant proposal access.
  // A completed skip report must never suppress the next scheduled pass.
  const bodyStart = customPrompt.indexOf("Queue-only on-page pass");
  if (bodyStart < 0) throw new Error("On-page execution template is missing");
  return [
    "Perform this pass on every scheduled run. The configured cadence controls timing.",
    "First list existing proposals. Skip a page/field when the same replacement is already pending or approved.",
    customPrompt.slice(bodyStart),
  ].join("\n\n");
}
