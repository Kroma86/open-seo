import { Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { AuthPageShell } from "@/client/features/auth/AuthPage";
import { useHostedAuthRouteGuard } from "@/client/features/auth/useHostedAuthRouteGuard";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedShellLayout,
});

function AuthenticatedShellLayout() {
  const authGate = useHostedAuthRouteGuard();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Hosted-only pages (onboarding, subscribe) stay hidden in self-host.
  // MCP consent must render: Cloudflare Access already gated the browser,
  // and Better Auth has no session there.
  if (!authGate.isHostedMode) {
    if (pathname !== "/oauth-consent") {
      return null;
    }
    return (
      <AuthPageShell>
        <Outlet />
      </AuthPageShell>
    );
  }

  if (!authGate.canRenderAuthenticatedContent) {
    return null;
  }

  return (
    <AuthPageShell>
      <Outlet />
    </AuthPageShell>
  );
}
