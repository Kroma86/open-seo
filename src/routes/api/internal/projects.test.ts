import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv, listProjects, createProject } = vi.hoisted(() => ({
  mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string; AUTH_MODE?: string },
  listProjects: vi.fn(),
  createProject: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    listProjects: (...args: unknown[]) => listProjects(...args),
    createProject: (...args: unknown[]) => createProject(...args),
  },
}));

import { handleGet, handlePost } from "./projects";

const TOKEN = "test-export-token";
const BASE = "http://localhost/api/internal/projects";
const ORG_ID = "shared-workspace";

type StoredProject = {
  id: string;
  name: string;
  domain: string | null;
  locationCode: number;
  languageCode: string;
};

const store: StoredProject[] = [];

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
  store.length = 0;
  listProjects.mockImplementation(async () => [...store]);
  createProject.mockImplementation(
    async (_organizationId: string, input: { name: string; domain?: string }) => {
      const project: StoredProject = {
        id: `project_${store.length + 1}`,
        name: input.name,
        domain: input.domain ?? null,
        locationCode: 2840,
        languageCode: "en",
      };
      store.push(project);
      return project;
    },
  );
});

describe("internal projects auth", () => {
  it("returns 503 agency_score_export_disabled when token unset", async () => {
    delete mockEnv.AGENCY_SCORE_EXPORT_TOKEN;
    const res = await handleGet(get());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "agency_score_export_disabled",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 503 agency_score_export_disabled when token empty", async () => {
    mockEnv.AGENCY_SCORE_EXPORT_TOKEN = "   ";
    const res = await handlePost(post({ name: "Acme" }, auth));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "agency_score_export_disabled",
    });
  });

  it("returns 401 when bearer is missing", async () => {
    const res = await handleGet(get());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when bearer is wrong", async () => {
    const res = await handlePost(
      post({ name: "Acme" }, { authorization: "Bearer wrong-token" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(createProject).not.toHaveBeenCalled();
  });
});

describe("internal projects handleGet", () => {
  it("returns an empty list when the organization has no projects", async () => {
    const res = await handleGet(get("", auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ projects: [] });
    expect(listProjects).toHaveBeenCalledWith(ORG_ID);
  });

  it("filters to exact case-insensitive domain matches", async () => {
    store.push(
      {
        id: "project_acme",
        name: "Acme",
        domain: "Example.com",
        locationCode: 2840,
        languageCode: "en",
      },
      {
        id: "project_other",
        name: "Other",
        domain: "other.com",
        locationCode: 2840,
        languageCode: "en",
      },
      {
        id: "project_none",
        name: "No domain",
        domain: null,
        locationCode: 2840,
        languageCode: "en",
      },
    );

    const res = await handleGet(get("?domain=example.com", auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projects: [
        {
          id: "project_acme",
          name: "Acme",
          domain: "Example.com",
          locationCode: 2840,
          languageCode: "en",
        },
      ],
    });
  });
});

describe("internal projects handlePost", () => {
  it("returns 400 invalid_json on malformed JSON", async () => {
    const res = await handlePost(post(undefined, auth, "{not-json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("returns 400 invalid_body for an empty name", async () => {
    const res = await handlePost(post({ name: "" }, auth));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_body when languageCode has no locationCode", async () => {
    const res = await handlePost(
      post({ name: "Acme", languageCode: "en" }, auth),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_body for overlong fields", async () => {
    const longName = await handlePost(
      post({ name: "a".repeat(121) }, auth),
    );
    expect(longName.status).toBe(400);
    expect(await longName.json()).toEqual({ error: "invalid_body" });

    const longDomain = await handlePost(
      post({ name: "Acme", domain: "a".repeat(256) }, auth),
    );
    expect(longDomain.status).toBe(400);
    expect(await longDomain.json()).toEqual({ error: "invalid_body" });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("creates a project and returns it on the subsequent list", async () => {
    const created = await handlePost(
      post(
        {
          name: "Acme",
          domain: "example.com",
          locationCode: 2840,
          languageCode: "en",
        },
        auth,
      ),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(await created.json()).toEqual({
      project: {
        id: "project_1",
        name: "Acme",
        domain: "example.com",
        locationCode: 2840,
        languageCode: "en",
      },
    });
    expect(createProject).toHaveBeenCalledWith(ORG_ID, {
      name: "Acme",
      domain: "example.com",
      locationCode: 2840,
      languageCode: "en",
    });

    const listed = await handleGet(get("?domain=example.com", auth));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      projects: [
        {
          id: "project_1",
          name: "Acme",
          domain: "example.com",
          locationCode: 2840,
          languageCode: "en",
        },
      ],
    });
  });
});

describe("auth-mode org scoping", () => {
  it("uses delegated-local-admin under AUTH_MODE=local_noauth", async () => {
    mockEnv.AUTH_MODE = "local_noauth";
    listProjects.mockResolvedValueOnce([]);

    const response = await handleGet(get("", auth));

    expect(response.status).toBe(200);
    expect(listProjects).toHaveBeenCalledWith("delegated-local-admin");
  });

  it("refuses both verbs with 403 under AUTH_MODE=hosted", async () => {
    mockEnv.AUTH_MODE = "hosted";

    const listed = await handleGet(get("", auth));
    expect(listed.status).toBe(403);
    expect(await listed.json()).toEqual({ error: "unsupported_auth_mode" });
    expect(listProjects).not.toHaveBeenCalled();

    const created = await handlePost(post({ name: "Acme" }, auth));
    expect(created.status).toBe(403);
    expect(await created.json()).toEqual({ error: "unsupported_auth_mode" });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("never reaches the service on an unauthorized GET", async () => {
    const response = await handleGet(get(""));

    expect(response.status).toBe(401);
    expect(listProjects).not.toHaveBeenCalled();
  });
});
