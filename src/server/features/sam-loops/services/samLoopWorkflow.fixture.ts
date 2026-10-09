import { vi } from "vitest";

type SamLoopWorkflowBinding = Env["SAM_LOOP_WORKFLOW"];

// Typed stand-in for the SAM_LOOP_WORKFLOW binding; `create` resolves a stub
// instance whose methods are inert mocks.
export function fakeSamLoopWorkflow() {
  const instance: WorkflowInstance = {
    id: "workflow_instance",
    pause: vi.fn(),
    resume: vi.fn(),
    terminate: vi.fn(),
    restart: vi.fn(),
    status: vi.fn(),
    sendEvent: vi.fn(),
  };
  const create = vi
    .fn<SamLoopWorkflowBinding["create"]>()
    .mockResolvedValue(instance);
  const workflow: SamLoopWorkflowBinding = {
    create,
    get: vi.fn(),
    createBatch: vi.fn(),
  };
  return { create, workflow };
}
