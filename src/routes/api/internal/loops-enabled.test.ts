import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnv,
  setLoopsEnabled,
  getProjectRow,
} = vi.hoisted(() => ({
  mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string; AUTH_MODE?: string },
  setLoopsEnabled: vi.fn(),
  getProjectRow: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    setLoopsEnabled: (...args: unknown[]) => setLoopsEnabled(...args),
  },
}));

vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectForOrganization: (...args: unknown[]) => getProjectRow(...args),
  },
}));

import { handleGet, handlePost } from "./loops-enabled";

const TOKEN = "test-export-token";
const BASE = "http://localhost/api/internal/loops-enabled";
const ORG_ID = "shared-workspace";
const PROJECT_ID = "project_1";

const PROJECT = {
  id: PROJECT_ID,
  name: "Acme",
  domain: "niceseo.ai",
  locationCode: 2840,
  languageCode: "en",
  createdAt: "2026-01-01 00:00:00",
  loopsEnabled: false,
};

function get(path = "", headers?: HeadersInit): Request {
  return new Request(`${BASE}${path}`, { headers });
}

function post(
  body?: unknown,
  headers?: HeadersInit,
  rawBody?: string,
): Request {
  return new Request(BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  delete mockEnv.AUTH_MODE;
  getProjectRow.mockImplementation(
    async (projectId: string, _organizationId: string) => {
      if (projectId === PROJECT_ID) return PROJECT;
      return null;
    },
  );
  setLoopsEnabled.mockImplementation(
    async (
      _organizationId: string,
      projectId: string,
      enabled: boolean,
    ) => ({
      ...PROJECT,
      id: projectId,
      loopsEnabled: enabled,
    }),
  );
});

describe("internal loops-enabled auth", () => {
  it("returns 401 when bearer is missing", async () => {
    const res = await handleGet(get(`?projectId=${PROJECT_ID}`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(getProjectRow).not.toHaveBeenCalled();
    expect(setLoopsEnabled).not.toHaveBeenCalled();
  });

  it("refuses both verbs with 403 under AUTH_MODE=hosted", async () => {
    mockEnv.AUTH_MODE = "hosted";

    const listed = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(listed.status).toBe(403);
    expect(await listed.json()).toEqual({ error: "unsupported_auth_mode" });

    const updated = await handlePost(
      post({ projectId: PROJECT_ID, enabled: true }, auth),
    );
    expect(updated.status).toBe(403);
    expect(await updated.json()).toEqual({ error: "unsupported_auth_mode" });
    expect(getProjectRow).not.toHaveBeenCalled();
    expect(setLoopsEnabled).not.toHaveBeenCalled();
  });
});

describe("internal loops-enabled handleGet", () => {
  it("returns 400 invalid_query when projectId is missing", async () => {
    const res = await handleGet(get("", auth));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_query" });
    expect(getProjectRow).not.toHaveBeenCalled();
  });

  it("returns 404 when the project is not in the resolved org", async () => {
    const res = await handleGet(get("?projectId=other_project", auth));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "project_not_found" });
    expect(getProjectRow).toHaveBeenCalledWith("other_project", ORG_ID);
  });

  it("returns projectId, domain, loopsEnabled, and houseDomain", async () => {
    const res = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      domain: "niceseo.ai",
      loopsEnabled: false,
      houseDomain: true,
    });
    expect(getProjectRow).toHaveBeenCalledTimes(1);
    expect(getProjectRow).toHaveBeenCalledWith(PROJECT_ID, ORG_ID);
  });
});

describe("internal loops-enabled handlePost", () => {
  it("returns 400 invalid_json on malformed JSON", async () => {
    const res = await handlePost(post(undefined, auth, "{not-json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expect(setLoopsEnabled).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_body when the body is not an object", async () => {
    const res = await handlePost(post(null, auth));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(setLoopsEnabled).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_body when enabled is the string "yes"', async () => {
    const res = await handlePost(
      post({ projectId: PROJECT_ID, enabled: "yes" }, auth),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(setLoopsEnabled).not.toHaveBeenCalled();
  });

  it("returns 404 when the project is not in the resolved org", async () => {
    const res = await handlePost(
      post({ projectId: "other_project", enabled: true }, auth),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "project_not_found" });
    expect(setLoopsEnabled).not.toHaveBeenCalled();
  });

  it("enables loops with the resolved org id", async () => {
    const res = await handlePost(
      post({ projectId: PROJECT_ID, enabled: true }, auth),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      domain: "niceseo.ai",
      loopsEnabled: true,
      houseDomain: true,
    });
    expect(setLoopsEnabled).toHaveBeenCalledWith(ORG_ID, PROJECT_ID, true);
  });

  it("disables loops without deleting them", async () => {
    const res = await handlePost(
      post({ projectId: PROJECT_ID, enabled: false }, auth),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      domain: "niceseo.ai",
      loopsEnabled: false,
      houseDomain: true,
    });
    expect(setLoopsEnabled).toHaveBeenCalledWith(ORG_ID, PROJECT_ID, false);
  });

  it("refuses to enable a project with no domain", async () => {
    getProjectRow.mockResolvedValue({ ...PROJECT, domain: null });
    const res = await handlePost(
      post({ projectId: PROJECT_ID, enabled: true }, auth),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "project_has_no_domain" });
    expect(setLoopsEnabled).not.toHaveBeenCalled();
  });

  it("refuses to enable a project with an empty domain", async () => {
    getProjectRow.mockResolvedValue({ ...PROJECT, domain: "   " });
    const res = await handlePost(
      post({ projectId: PROJECT_ID, enabled: true }, auth),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "project_has_no_domain" });
    expect(setLoopsEnabled).not.toHaveBeenCalled();
  });

  it("returns 404 when enabling loops on an archived project", async () => {
    getProjectRow.mockResolvedValue(null);
    const res = await handlePost(
      post({ projectId: PROJECT_ID, enabled: true }, auth),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "project_not_found" });
    expect(setLoopsEnabled).not.toHaveBeenCalled();
  });

  it("returns 404 when disabling loops on an archived project", async () => {
    getProjectRow.mockResolvedValue(null);
    const res = await handlePost(
      post({ projectId: PROJECT_ID, enabled: false }, auth),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "project_not_found" });
    expect(setLoopsEnabled).not.toHaveBeenCalled();
  });

  it("still disables a project with no domain", async () => {
    const untitled = { ...PROJECT, domain: null, loopsEnabled: false };
    getProjectRow.mockResolvedValue(untitled);
    setLoopsEnabled.mockResolvedValue(untitled);
    const res = await handlePost(
      post({ projectId: PROJECT_ID, enabled: false }, auth),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      domain: null,
      loopsEnabled: false,
      houseDomain: false,
    });
    expect(setLoopsEnabled).toHaveBeenCalledWith(ORG_ID, PROJECT_ID, false);
  });
});

describe("auth-mode org scoping", () => {
  it("uses delegated-local-admin under AUTH_MODE=local_noauth", async () => {
    mockEnv.AUTH_MODE = "local_noauth";

    const listed = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(listed.status).toBe(200);
    expect(getProjectRow).toHaveBeenCalledWith(
      PROJECT_ID,
      "delegated-local-admin",
    );

    const updated = await handlePost(
      post({ projectId: PROJECT_ID, enabled: true }, auth),
    );
    expect(updated.status).toBe(200);
    expect(setLoopsEnabled).toHaveBeenCalledWith(
      "delegated-local-admin",
      PROJECT_ID,
      true,
    );
  });
});
