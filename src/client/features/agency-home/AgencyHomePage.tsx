import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  getErrorCode,
  getStandardErrorMessage,
} from "@/client/lib/error-messages";
import { AuthConfigErrorCard } from "@/client/components/AuthConfigErrorCard";
import { UnauthenticatedErrorCard } from "@/client/components/UnauthenticatedErrorCard";
import { AgencyHomeAlertsCard } from "@/client/features/agency-home/AgencyHomeAlertsCard";
import { AgencyHomeMissionsRail } from "@/client/features/agency-home/AgencyHomeMissionsRail";
import { AgencyHomePortfolioTable } from "@/client/features/agency-home/AgencyHomePortfolioTable";
import { AgencyHomePromptBar } from "@/client/features/agency-home/AgencyHomePromptBar";
import { AgencyHomeWorkflowChips } from "@/client/features/agency-home/AgencyHomeWorkflowChips";
import type { AgencyWorkflowChip } from "@/client/features/agency-home/workflowChips";
import {
  getAgencyHomeMissions,
  getAgencyHomePortfolio,
} from "@/serverFunctions/agency-home";
import { getLatestAlertCycle } from "@/serverFunctions/agency-ops";
import { getProjects } from "@/serverFunctions/projects";
import { SUBSCRIBE_ROUTE } from "@/shared/billing";

export function AgencyHomePage() {
  const navigate = useNavigate();
  const [promptSeed, setPromptSeed] = useState("");
  const [promptKey, setPromptKey] = useState(0);

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => getProjects(),
    retry: false,
  });

  const missionsQuery = useQuery({
    queryKey: ["agency-home-missions"],
    queryFn: () => getAgencyHomeMissions(),
    enabled: Boolean(projectsQuery.data?.length),
  });

  const portfolioQuery = useQuery({
    queryKey: ["agency-home-portfolio"],
    queryFn: () => getAgencyHomePortfolio(),
    enabled: Boolean(projectsQuery.data?.length),
  });

  // Not gated on projects: ops artifacts are box-wide, not project-bound.
  const alertsQuery = useQuery({
    queryKey: ["agency-home-alerts"],
    queryFn: () => getLatestAlertCycle(),
  });

  useEffect(() => {
    if (getErrorCode(projectsQuery.error) !== "PAYMENT_REQUIRED") return;
    void navigate({ href: SUBSCRIBE_ROUTE });
  }, [projectsQuery.error, navigate]);

  const applyChip = (chip: AgencyWorkflowChip) => {
    setPromptSeed(chip.prompt);
    setPromptKey((k) => k + 1);
  };

  // Hooks must run on every render — keep this above the early returns.
  const missions = missionsQuery.data;
  const runningProjectIds = useMemo(
    () =>
      new Set(
        (missions ?? [])
          .filter((mission) => mission.status === "running")
          .map((mission) => mission.projectId),
      ),
    [missions],
  );

  if (projectsQuery.isError) {
    const errorCode = getErrorCode(projectsQuery.error);

    if (errorCode === "AUTH_CONFIG_MISSING") {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <AuthConfigErrorCard
            message={getStandardErrorMessage(
              projectsQuery.error,
              "An unexpected error occurred. Please check server logs.",
            )}
            onRetry={() => {
              void projectsQuery.refetch();
            }}
          />
        </div>
      );
    }

    if (errorCode === "UNAUTHENTICATED") {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <UnauthenticatedErrorCard
            message="Please sign in to access your OpenSEO workspace."
            onRetry={() => {
              void projectsQuery.refetch();
            }}
          />
        </div>
      );
    }

    if (errorCode === "PAYMENT_REQUIRED") {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <p className="max-w-xl text-center text-base-content/80">
            Redirecting you to billing so you can start a hosted subscription.
          </p>
        </div>
      );
    }

    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-center text-error">
          {getStandardErrorMessage(
            projectsQuery.error,
            "An unexpected error occurred. Please check server logs.",
          )}
        </p>
      </div>
    );
  }

  if (projectsQuery.isLoading || !projectsQuery.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="loading loading-spinner loading-md" />
      </div>
    );
  }

  const projects = projectsQuery.data;

  return (
    <div className="h-full overflow-auto bg-base-100">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 pb-24 md:px-6 md:py-10 md:pb-10">
        <header className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-base-content/45">
            Agency home
          </p>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
            Put Sam to work
          </h1>
          <p className="max-w-2xl text-sm text-base-content/55">
            Ask across your portfolio, scan recent missions, and open any
            client workspace in one click. Every number here is measured — or
            explicitly not.
          </p>
        </header>

        <AgencyHomePromptBar
          key={promptKey}
          projects={projects}
          initialPrompt={promptSeed}
        />

        <AgencyHomeWorkflowChips onSelect={applyChip} />

        <AgencyHomeMissionsRail
          missions={missions ?? []}
          isLoading={missionsQuery.isLoading}
        />

        <AgencyHomeAlertsCard
          data={alertsQuery.data}
          isLoading={alertsQuery.isLoading}
          isError={alertsQuery.isError}
        />

        <AgencyHomePortfolioTable
          rows={portfolioQuery.data ?? []}
          isLoading={portfolioQuery.isLoading}
          runningProjectIds={runningProjectIds}
        />
      </div>
    </div>
  );
}
