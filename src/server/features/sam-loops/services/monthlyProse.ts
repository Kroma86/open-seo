/** A conservative prose check, not a complete Markdown parser. */
export function developedProseBlocks(body: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  let excluded = false;
  let fence: { character: string; length: number } | null = null;
  const finish = () => {
    const text = lines.join("\n").trim();
    if (text && text.split(/\s+/).length >= 35) blocks.push(text);
    lines = [];
  };
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/)?.[1];
      if (closing && closing[0] === fence.character && closing.length >= fence.length) fence = null;
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (opening) {
      finish();
      fence = { character: opening[0]!, length: opening.length };
      continue;
    }
    if (!line.trim()) {
      finish();
      excluded = false;
      continue;
    }
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) {
      finish();
      excluded = false;
      continue;
    }
    if (/^\s*(?:[-*+•]|\d{1,9}[.)])\s/.test(line) || /^(?: {4}|\t)/.test(line)) {
      finish();
      excluded = true;
    }
    if (!excluded) lines.push(line);
  }
  finish();
  return blocks;
}
