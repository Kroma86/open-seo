import { describe, expect, it } from "vitest";
import { errors as joseErrors } from "jose";

// The middleware's audience fallback hinges on jose's JWTClaimValidationFailed
// carrying a `.claim` field under the JOSEError hierarchy. The mocked
// middleware tests pin the repo's BELIEF about that shape; this pins the REAL
// library contract — if jose changes it, this test (not a mock) breaks.
describe("jose error contract (real library, unmocked)", () => {
  it("JWTClaimValidationFailed exposes .claim and extends JOSEError", () => {
    const err = new joseErrors.JWTClaimValidationFailed(
      'invalid "aud" (audience) claim',
      {},
      "aud",
    );
    expect(err.claim).toBe("aud");
    expect(err).toBeInstanceOf(joseErrors.JOSEError);
  });
});
