import { afterEach, describe, expect, test } from "bun:test";
import { pagesHandler } from "./pages.ts";
import * as store from "./store.ts";

const createdCodes: string[] = [];

afterEach(() => {
  for (const code of createdCodes.splice(0)) store.close(code);
});

function create(code: string): string {
  store.create(code);
  createdCodes.push(code);
  return code;
}

describe("page and installer routes", () => {
  test("serves the home page", async () => {
    const req = new Request("http://test.local/");
    const res = pagesHandler(req, new URL(req.url));
    expect(res?.headers.get("Content-Type")).toContain("text/html");
    expect(await res!.text()).toContain("Connect Your Agent");
  });

  test("serves Unix installer without Python or PTY dependencies", async () => {
    const code = create("333333333333");
    const req = new Request(`http://test.local/c/${code}?raw=1`, { headers: { Host: "test.local" } });
    const res = pagesHandler(req, new URL(req.url));
    const script = await res!.text();

    expect(script).toContain("#!/bin/bash");
    expect(script).toContain(`CODE="${code}"`);
    expect(script).toContain("cya-bridge-${OS}-${ARCH}");
    expect(script).toContain("BRIDGE_WS_URL");
    expect(script).not.toContain("python3");
    expect(script.toLowerCase()).not.toContain("pty");
  });

  test("serves Windows PowerShell installer", async () => {
    const code = create("444444444444");
    const req = new Request(`https://test.local/c/${code}/windows.ps1`, { headers: { Host: "test.local", "X-Forwarded-Proto": "https" } });
    const res = pagesHandler(req, new URL(req.url));
    const script = await res!.text();

    expect(script).toContain("$ErrorActionPreference = \"Stop\"");
    expect(script).toContain(`$Code = "${code}"`);
    expect(script).toContain("cya-bridge-windows-x64.exe");
    expect(script).toContain("wss://test.local/ws");
    expect(script).toContain("Invoke-WebRequest");
  });

  test("returns prompt content for existing sessions", async () => {
    const code = create("555555555555");
    const req = new Request(`http://test.local/c/${code}/prompt.md`);
    const res = pagesHandler(req, new URL(req.url));
    const prompt = await res!.text();

    expect(res?.headers.get("Content-Type")).toContain("text/markdown");
    expect(prompt).toContain("non-interactive shell command access");
  });
});
