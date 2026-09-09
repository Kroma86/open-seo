import { describe, expect, it } from "vitest";
import { filterSearchableOptions } from "./SearchableSelect";

const options = [
  {
    value: "sub-a:properties/111",
    label: "Acme Inc · Acme Marketing",
    hint: "properties/111",
    group: "owner@acme.com",
    keywords: ["sub-a"],
  },
  {
    value: "sub-b:https://beta.io/",
    label: "https://beta.io/",
    group: "ops@beta.io",
    keywords: ["sub-b"],
  },
];

describe("filterSearchableOptions", () => {
  it("returns every option for a blank query", () => {
    expect(filterSearchableOptions(options, "  ")).toEqual(options);
  });

  it("matches label, hint, group and keywords case-insensitively", () => {
    expect(filterSearchableOptions(options, "MARKET")).toEqual([options[0]]);
    expect(filterSearchableOptions(options, "111")).toEqual([options[0]]);
    expect(filterSearchableOptions(options, "ops@beta")).toEqual([options[1]]);
    expect(filterSearchableOptions(options, "sub-b")).toEqual([options[1]]);
    expect(filterSearchableOptions(options, "nothing")).toEqual([]);
  });
});
