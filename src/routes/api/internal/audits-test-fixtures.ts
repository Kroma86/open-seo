import type { audits } from "@/db/schema";
import type { AuditService } from "@/server/features/audit/services/AuditService";
import { PROJECT_ID } from "./internal-route-test-support";

export const STARTED_AUDIT_ID = "00000000-0000-4000-8000-000000000001";

export const AUDIT: typeof audits.$inferSelect = {
  id: "audit_1",
  projectId: PROJECT_ID,
  startedByUserId: "user_early",
  startUrl: "https://example.com",
  status: "running",
  workflowInstanceId: null,
  config: "{}",
  pagesCrawled: 0,
  pagesTotal: 0,
  lighthouseTotal: 0,
  lighthouseCompleted: 0,
  lighthouseFailed: 0,
  currentPhase: "discovery",
  errorCode: null,
  errorDetail: null,
  failedPhase: null,
  startedAt: "2026-08-01 00:00:00",
  completedAt: null,
};

type AuditStatus = Awaited<ReturnType<(typeof AuditService)["getStatus"]>>;
type AuditHistory = Awaited<ReturnType<(typeof AuditService)["getHistory"]>>;

export const STATUS: AuditStatus = {
  id: "audit_1",
  startUrl: "https://example.com",
  status: "running",
  pagesCrawled: 0,
  pagesTotal: 0,
  lighthouseTotal: 0,
  lighthouseCompleted: 0,
  lighthouseFailed: 0,
  currentPhase: "discovery",
  errorCode: null,
  startedAt: "2026-08-01 00:00:00",
  completedAt: null,
};

export function historyEntry(id: string): AuditHistory[number] {
  return {
    id,
    startUrl: "https://example.com",
    status: "completed",
    pagesCrawled: 0,
    pagesTotal: 0,
    ranLighthouse: true,
    startedAt: "2026-08-01 00:00:00",
    completedAt: null,
  };
}
