import { describe, expect, it } from "vitest";
import { developedProseBlocks } from "./monthlyProse";
const words = (n: number) => Array(n).fill("word").join(" ");
describe("developed prose blocks", () => {
  it("keeps prose immediately following headings and preceding a heading", () => {
    expect(developedProseBlocks(Array.from({ length: 4 }, (_, i) => `## Section ${i}\n${words(150)}`).join("\n\n"))).toHaveLength(4);
    expect(developedProseBlocks(Array(4).fill(words(150)).join("\n\n"))).toHaveLength(4);
    expect(developedProseBlocks(`${words(35)}\n# Heading\n${words(35)}`)).toHaveLength(2);
  });
  it("does not use heading words to inflate short paragraphs", () => {
    expect(developedProseBlocks(`# ${words(460)}\n\n${Array(4).fill(words(34)).join("\n\n")}`)).toEqual([]);
  });
  it.each(["1)", "1.", "-", "+", "•", "*"])("excludes %s lists and their nonblank continuations", (marker) => {
    expect(developedProseBlocks(`${marker} ${words(40)}\n${words(40)}\n    ${words(40)}`)).toEqual([]);
    expect(developedProseBlocks(`${marker} ${words(40)}\n\n${words(35)}`)).toEqual([words(35)]);
    expect(developedProseBlocks(`${marker} ${words(40)}\n# Heading\n${words(35)}`)).toEqual([words(35)]);
  });
  it.each(["```", "~~~"])("excludes fenced code and blank lines inside %s", (fence) => {
    const other = fence === "```" ? "~~~" : "```";
    expect(developedProseBlocks(`${fence}code\n${words(40)}\n\n# Heading\n${other}\n${words(40)}\n${fence}\n${words(35)}`)).toEqual([words(35)]);
    expect(developedProseBlocks(`${fence}\n${words(40)}`)).toEqual([]);
    expect(developedProseBlocks(`${fence}${fence[0]}\n${words(40)}\n${fence}\n${words(40)}`)).toEqual([]);
  });
  it.each(["    ", "\t"])("excludes indented code and its continuation", (indent) => {
    expect(developedProseBlocks(`${indent}${words(40)}\n${words(40)}\n\n${words(35)}`)).toEqual([words(35)]);
  });
  it("preserves trimmed text, normalizes newlines and enforces 35 words", () => {
    expect(developedProseBlocks(" \r\n\t ")).toEqual([]);
    expect(developedProseBlocks(words(34))).toEqual([]);
    expect(developedProseBlocks(words(35))).toEqual([words(35)]);
    expect(developedProseBlocks(`# Heading\r\n${words(20)}\r${words(15)}  `)).toEqual([`${words(20)}\n${words(15)}`]);
  });
});
