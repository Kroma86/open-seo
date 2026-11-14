import { expect, it } from "vitest";
import {
  estimateAnswers,
  MEASUREMENT_V2,
  PILOT_PROJECTS,
  validateEnrollments,
} from "./policy";
const start = "2026-11-13T00:00:00Z";
const rows = () =>
  Object.entries(PILOT_PROJECTS).map(([projectId, domain]) => ({
    projectId,
    domain,
    configId: "00000000-0000-4000-8000-000000000001",
    contextHash: "a".repeat(64),
    eligibilityEvidence: "synthetic receipt",
    eligibilityHash: "b".repeat(64),
    verifiedAt: start,
    startsAt: start,
    dryRunAt: null,
    dryRunHash: null,
  }));
it("ships OFF and dry-run first", () => {
  expect(MEASUREMENT_V2).toEqual({
    enabled: false,
    dryRun: true,
    spendBoundVerified: false,
  });
  expect(() => validateEnrollments(rows(), new Date(start), true)).toThrow(
    "Dry run",
  );
});
it("requires exactly five unique allowed enrollments with current evidence", () => {
  expect(validateEnrollments(rows(), new Date(start), false)).toHaveLength(5);
  expect(() =>
    validateEnrollments(rows().slice(0, 4), new Date(start), false),
  ).toThrow();
  const duplicate = rows();
  duplicate[4] = duplicate[0];
  expect(() => validateEnrollments(duplicate, new Date(start), false)).toThrow(
    "distinct",
  );
  const unknown = rows();
  unknown[0].projectId = "00000000-0000-4000-8000-000000000099";
  expect(() => validateEnrollments(unknown, new Date(start), false)).toThrow(
    "allowlist",
  );
  const missing = rows();
  missing[0].eligibilityHash = "";
  expect(() => validateEnrollments(missing, new Date(start), false)).toThrow();
});
it("expires precisely seven days after start, without resetting on a poll", () => {
  expect(
    validateEnrollments(rows(), new Date("2026-11-19T23:59:59Z"), false),
  ).toHaveLength(5);
  expect(() =>
    validateEnrollments(rows(), new Date("2026-11-20T00:00:00Z"), false),
  ).toThrow("expired");
  expect(() =>
    validateEnrollments(rows(), new Date("2026-11-12T23:59:59Z"), false),
  ).toThrow();
});

it("applies the shared 1.28 markup per engine batch within the hard billed cap", () => {
  const estimate = estimateAnswers(15);
  expect(estimate.rawCredits * 5).toBe(360);
  expect(estimate.credits * 5).toBeCloseTo(460.8);
  expect(estimateAnswers(11).credits).toBe(67.59);
});
