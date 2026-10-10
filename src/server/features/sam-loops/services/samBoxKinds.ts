import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import type { SamBoxKind } from "./samBoxTypes";

export function samBoxKindForLoop(loop: {
  sourceType: string;
  customPrompt: string | null;
}): SamBoxKind | null {
  if (loop.sourceType !== "custom" || loop.customPrompt === null) return null;
  const onPageTemplate = DEFAULT_SAM_LOOP_TEMPLATES.find(
    (template) => template.name === "On-page priorities",
  );
  if (loop.customPrompt === onPageTemplate?.customPrompt) {
    return "on_page_priorities";
  }
  const ctrTemplate = DEFAULT_SAM_LOOP_TEMPLATES.find(
    (template) => template.name === "CTR opportunities",
  );
  if (loop.customPrompt === ctrTemplate?.customPrompt) {
    return "ctr_opportunities";
  }
  return null;
}
