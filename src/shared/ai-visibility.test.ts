import { describe, expect, it } from "vitest";
import { promptExplorerModelsForPlatforms } from "./ai-visibility";

describe("promptExplorerModelsForPlatforms", () => {
  it("returns all four prompt-explorer models in config order, deduped", () => {
    expect(
      promptExplorerModelsForPlatforms([
        "google",
        "perplexity",
        "chat_gpt",
        "claude",
        "gemini",
        "chat_gpt",
      ]),
    ).toEqual(["perplexity", "chat_gpt", "claude", "gemini"]);
  });
});
