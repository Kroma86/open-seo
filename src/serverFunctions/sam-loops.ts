import { createServerFn } from "@tanstack/react-start";
import { SamLoopService } from "@/server/features/sam-loops/services/SamLoopService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  createSamLoopSchema,
  getSamLoopRunSchema,
  getSamLoopRunsSchema,
  listSamLoopsSchema,
  triggerSamLoopSchema,
  updateSamLoopSchema,
} from "@/types/schemas/sam-loops";

export const listSamLoops = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listSamLoopsSchema)
  .handler(async ({ context }) => {
    return SamLoopService.listSamLoopsForProject(context.projectId);
  });

export const listSamLoopSkills = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listSamLoopsSchema)
  .handler(async () => {
    const skills = await SamLoopService.listAvailableSamLoopSkills();
    return skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
    }));
  });

export const createSamLoop = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(createSamLoopSchema)
  .handler(async ({ data, context }) => {
    return SamLoopService.createSamLoop({
      ...data,
      projectId: context.projectId,
    });
  });

export const updateSamLoop = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateSamLoopSchema)
  .handler(async ({ data, context }) => {
    return SamLoopService.updateSamLoop({
      ...data,
      projectId: context.projectId,
    });
  });

export const getSamLoopRuns = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getSamLoopRunsSchema)
  .handler(async ({ data, context }) => {
    return SamLoopService.getSamLoopRuns({
      projectId: context.projectId,
      loopId: data.loopId,
      limit: data.limit,
    });
  });

export const getSamLoopRun = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getSamLoopRunSchema)
  .handler(async ({ data, context }) => {
    return SamLoopService.getSamLoopRun({
      projectId: context.projectId,
      runId: data.runId,
    });
  });

export const triggerSamLoop = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(triggerSamLoopSchema)
  .handler(async ({ data, context }) => {
    return SamLoopService.triggerSamLoop({
      projectId: context.projectId,
      loopId: data.loopId,
      organizationId: context.organizationId,
    });
  });

export const seedDefaultSamLoops = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listSamLoopsSchema)
  .handler(async ({ context }) => {
    return SamLoopService.seedDefaultSamLoopsForProject(context.projectId);
  });

export const getContentVelocity = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listSamLoopsSchema)
  .handler(async ({ context }) => {
    return SamLoopService.getContentVelocity(context.projectId);
  });
