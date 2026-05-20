import { afterEach, describe, expect, test } from "bun:test";
import { apiHandler, buildPrompt, generateCode, toSessionResponse } from "./api.ts";
import * as store from "./store.ts";

const createdCodes: string[] = [];

afterEach(() => {
  for (const code of createdCodes.splice(0)) store.close(code);
});

function track(code: string): string {
  createdCodes.push(code);
  return code;
}

async function json(res: Response): Promise<any> {
  return await res.json();
}

describe("session API", () => {
  test("generateCode returns valid 12-char lowercase hex codes", () => {
    for (let i = 0; i < 50; i++) {
      expect(store.isSessionCode(generateCode())).toBe(true);
    }
  });

  test("creates sessions through GET and POST", async () => {
    for (const method of ["GET", "POST"] as const) {
      const req = new Request("http://test.local/api/session", { method, headers: { Host: "test.local" } });
      const res = apiHandler(req, new URL(req.url));
      expect(res).toBeInstanceOf(Response);
      const body = await json(await res as Response);
      track(body.code);
      expect(store.isSessionCode(body.code)).toBe(true);
      expect(body.status).toBe("waiting");
      expect(body.connect_url).toBe(`http://test.local/c/${body.code}`);
    }
  });

  test("returns 404 for unknown sessions", async () => {
    const req = new Request("http://test.local/api/session/abcdefabcdef");
    const res = apiHandler(req, new URL(req.url)) as Response;
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "Not found" });
  });

  test("rejects command requests while the agent is disconnected", async () => {
    const code = track(store.create("111111111111").code);
    const req = new Request(`http://test.local/api/session/${code}/run?cmd=pwd`);
    const res = await apiHandler(req, new URL(req.url)) as Response;
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: "Agent not connected" });
  });

  test("renders prompt as non-interactive one-shot command guidance", () => {
    const session = store.create(track("222222222222"));
    const prompt = buildPrompt(toSessionResponse(session, "http://test.local"), "http://test.local");

    expect(prompt).toContain("non-interactive shell command access");
    expect(prompt).toContain("cmd_b64");
    expect(prompt).toContain("http://test.local/api/session/222222222222/run?cmd=");
  });
});
