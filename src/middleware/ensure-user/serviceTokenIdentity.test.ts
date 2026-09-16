import { describe, expect, it } from "vitest";
import { serviceTokenIdentity } from "./serviceTokenIdentity";

// Names that a lossy character map (lower-case + replace disallowed with "-")
// flattens onto ONE value. The user table's email is UNIQUE, so a flattened
// pair either merges two machines into one row or fails the second insert
// forever. Every pair below must stay distinct.
const COLLIDING_UNDER_A_SLUG = [
  "ci-bot",
  "CI-BOT",
  "ci bot",
  "ci/bot",
  "ci@bot",
  "ci.bot",
  "foo-",
  "foo!",
  "foo?",
  "a-b-c",
  "a b/c",
];

describe("serviceTokenIdentity", () => {
  it("keeps the token's name exactly in the id, so an operator can read which machine called", async () => {
    expect(await serviceTokenIdentity("grok-bot.access")).toEqual({
      userId: "cf-service-token:grok-bot.access",
      userEmail: expect.stringMatching(/^[0-9a-f]{40}@service-token\.invalid$/),
    });
  });

  it("gives every one of these names its own id AND its own address (a character map would merge them)", async () => {
    const ids = new Set<string>();
    const emails = new Set<string>();
    for (const name of COLLIDING_UNDER_A_SLUG) {
      const { userId, userEmail } = await serviceTokenIdentity(name);
      ids.add(userId);
      emails.add(userEmail);
    }
    expect(ids.size).toBe(COLLIDING_UNDER_A_SLUG.length);
    expect(emails.size).toBe(COLLIDING_UNDER_A_SLUG.length);
  });

  it.each([
    ["ci-bot", "CI-BOT"],
    ["ci-bot", "ci bot"],
    ["ci-bot", "ci@bot"],
    ["foo-", "foo!"],
    ["a-b-c", "a b/c"],
  ])("keeps %s and %s on separate rows", async (a, b) => {
    const left = await serviceTokenIdentity(a);
    const right = await serviceTokenIdentity(b);
    expect(left.userId).not.toBe(right.userId);
    expect(left.userEmail).not.toBe(right.userEmail);
  });

  it("is stable across calls, so a machine keeps one row instead of minting a new one per request", async () => {
    expect(await serviceTokenIdentity("grok-bot.access")).toEqual(
      await serviceTokenIdentity("grok-bot.access"),
    );
  });

  it("never emits an address that could reach a real mailbox, whatever the name contains", async () => {
    for (const name of [...COLLIDING_UNDER_A_SLUG, "x@y", "a".repeat(300), ""]) {
      const { userEmail } = await serviceTokenIdentity(name);
      // .invalid is reserved by RFC 2606 and can never resolve.
      expect(userEmail.endsWith("@service-token.invalid")).toBe(true);
      expect(userEmail.split("@").length - 1).toBe(1);
      // RFC 5321 caps the local part at 64 octets; a name of any length must
      // not push past it.
      expect(userEmail.split("@")[0].length).toBeLessThanOrEqual(64);
    }
  });
});
