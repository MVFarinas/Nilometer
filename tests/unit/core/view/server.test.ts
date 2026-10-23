/**
 * @file Unit tests for core/view/server.ts, the server behind `nilometer view` (D-097, step G6.2).
 *
 * The routing rules are tested as a pure function, then a real server on 127.0.0.1 is sent the
 * requests a browser, another site, and a DNS-rebinding page would send.
 */
import { type Server, request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  RESPONSE_HEADERS,
  type RefreshResult,
  allowedHosts,
  createViewServer,
  listenView,
  route,
} from "../../../../core/view/server.js";

/** This run's token in every test. */
const TOKEN = "test-token";

/**
 * A request as {@link route} reads it, on port 4000 with this server's own Host.
 * @param over - Fields to change.
 * @returns The request facts.
 */
const facts = (over: Partial<Parameters<typeof route>[0]> = {}) => ({
  method: "GET",
  url: `/${TOKEN}/`,
  host: "127.0.0.1:4000",
  origin: undefined,
  ...over,
});

describe("route", () => {
  it("serves the page to a GET or HEAD on the token's path, from either local host name", () => {
    expect(route(facts(), TOKEN, 4000)).toEqual({ kind: "page" });
    expect(route(facts({ method: "HEAD", url: `/${TOKEN}/?x=1` }), TOKEN, 4000)).toEqual({
      kind: "page",
    });
    expect(route(facts({ host: "LOCALHOST:4000" }), TOKEN, 4000)).toEqual({ kind: "page" });
    expect(allowedHosts(4000)).toEqual(["127.0.0.1:4000", "localhost:4000"]);
  });

  it("refreshes only on a POST from this server's own origin", () => {
    const post = { method: "POST", url: `/${TOKEN}/refresh` };
    expect(route(facts({ ...post, origin: "http://127.0.0.1:4000" }), TOKEN, 4000)).toEqual({
      kind: "refresh",
    });
    expect(route(facts({ ...post, origin: "http://localhost:4000" }), TOKEN, 4000)).toEqual({
      kind: "refresh",
    });
    for (const origin of [undefined, "https://example.com", "http://127.0.0.1:4001", "null"]) {
      expect(route(facts({ ...post, origin }), TOKEN, 4000)).toMatchObject({
        kind: "refuse",
        status: 403,
      });
    }
  });

  it("refuses another host, as a DNS-rebinding page would send, before looking at the path", () => {
    for (const host of [undefined, "evil.example:4000", "127.0.0.1:4001", "192.168.1.5:4000"]) {
      expect(route(facts({ host }), TOKEN, 4000)).toEqual({
        kind: "refuse",
        status: 403,
        reason: "unknown host",
      });
    }
  });

  it("answers 404 for a wrong, missing or longer token, and any other path", () => {
    for (const url of [
      "/",
      "/wrong/",
      `/${TOKEN}`,
      `/${TOKEN}x/`,
      `/${TOKEN}/other`,
      "/favicon.ico",
    ]) {
      expect(route(facts({ url }), TOKEN, 4000)).toMatchObject({ kind: "refuse", status: 404 });
    }
  });

  it("answers 405 for the wrong method on a right path", () => {
    expect(route(facts({ method: "POST" }), TOKEN, 4000)).toMatchObject({ status: 405 });
    expect(route(facts({ url: `/${TOKEN}/refresh` }), TOKEN, 4000)).toMatchObject({
      status: 405,
    });
  });
});

/** Servers to close after each test. */
const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise((done) => s.close(done))));
});

/**
 * Starts a server on a free loopback port.
 * @param refresh - What a refresh does.
 * @returns The server's port and how many refreshes ran.
 */
async function start(
  refresh: () => RefreshResult,
): Promise<{ port: number; refreshes: () => number }> {
  let count = 0;
  const server = createViewServer({
    token: TOKEN,
    page: () => "<!doctype html><title>page</title>",
    refresh: () => {
      count += 1;
      return refresh();
    },
  });
  open.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    refreshes: () => count,
  };
}

/**
 * Sends a request with exactly the headers given, as another page or a script could.
 * @param port - The server's port.
 * @param method - HTTP method.
 * @param path - Request target.
 * @param headers - Headers, Host included.
 * @returns Status, headers and body.
 */
function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("createViewServer", () => {
  it("serves the page with headers that keep it to itself", async () => {
    const { port } = await start(() => ({ ok: true, message: "" }));
    const page = await send(port, "GET", `/${TOKEN}/`, { Host: `127.0.0.1:${port}` });
    expect(page.status).toBe(200);
    expect(page.body).toBe("<!doctype html><title>page</title>");
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toBe(
      RESPONSE_HEADERS["Content-Security-Policy"],
    );
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    const head = await send(port, "HEAD", `/${TOKEN}/`, { Host: `localhost:${port}` });
    expect([head.status, head.body]).toEqual([200, ""]);
  });

  it("refreshes for its own page, and for nobody else", async () => {
    const { port, refreshes } = await start(() => ({ ok: true, message: "3 new lines read" }));
    const own = await send(port, "POST", `/${TOKEN}/refresh`, {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
    });
    expect([own.status, JSON.parse(own.body)]).toEqual([
      200,
      { ok: true, message: "3 new lines read" },
    ]);
    const otherSite = await send(port, "POST", `/${TOKEN}/refresh`, {
      Host: `127.0.0.1:${port}`,
      Origin: "https://example.com",
    });
    const rebinding = await send(port, "POST", `/${TOKEN}/refresh`, {
      Host: `evil.example:${port}`,
      Origin: `http://evil.example:${port}`,
    });
    const guessed = await send(port, "POST", "/guess/refresh", {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
    });
    expect([otherSite.status, rebinding.status, guessed.status]).toEqual([403, 403, 404]);
    expect(otherSite.headers["content-type"]).toBe("text/plain; charset=utf-8");
    // Only the page's own request ran a refresh.
    expect(refreshes()).toBe(1);
  });

  it("reports a refresh that fails or throws as a 500 with its message", async () => {
    const failing = await start(() => ({ ok: false, message: "no database" }));
    const failed = await send(failing.port, "POST", `/${TOKEN}/refresh`, {
      Host: `127.0.0.1:${failing.port}`,
      Origin: `http://127.0.0.1:${failing.port}`,
    });
    expect([failed.status, JSON.parse(failed.body)]).toEqual([
      500,
      { ok: false, message: "no database" },
    ]);
    const throwing = await start(() => {
      throw new Error("disk full");
    });
    const thrown = await send(throwing.port, "POST", `/${TOKEN}/refresh`, {
      Host: `127.0.0.1:${throwing.port}`,
      Origin: `http://127.0.0.1:${throwing.port}`,
    });
    expect([thrown.status, JSON.parse(thrown.body)]).toEqual([
      500,
      { ok: false, message: "disk full" },
    ]);
    const nonError = await start(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error thrown value is the case under test
      throw "plain";
    });
    const plain = await send(nonError.port, "POST", `/${TOKEN}/refresh`, {
      Host: `127.0.0.1:${nonError.port}`,
      Origin: `http://127.0.0.1:${nonError.port}`,
    });
    expect(JSON.parse(plain.body)).toEqual({ ok: false, message: "plain" });
  });
});

describe("listenView", () => {
  it("listens on 127.0.0.1 and gives the page's address", async () => {
    const url = await new Promise<string>((resolve, reject) => {
      open.push(
        listenView({
          token: TOKEN,
          port: 0,
          page: () => "",
          refresh: () => ({ ok: true, message: "" }),
          onListening: resolve,
          onError: reject,
        }),
      );
    });
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${TOKEN}/$`));
    const server = open[0];
    const address = server?.address();
    expect(typeof address === "object" && address?.address).toBe("127.0.0.1");
  });

  it("says when the port is taken, and passes any other error on", async () => {
    const { port } = await start(() => ({ ok: true, message: "" }));
    const message = await new Promise<string>((resolve) => {
      open.push(
        listenView({
          token: TOKEN,
          port,
          page: () => "",
          refresh: () => ({ ok: true, message: "" }),
          onListening: () => undefined,
          onError: resolve,
        }),
      );
    });
    expect(message).toBe(
      `port ${port} on 127.0.0.1 is in use; choose another with --port, or leave it out for any free port`,
    );
    const other = await new Promise<string>((resolve) => {
      const server = listenView({
        token: TOKEN,
        port: 0,
        page: () => "",
        refresh: () => ({ ok: true, message: "" }),
        onListening: () => undefined,
        onError: resolve,
      });
      open.push(server);
      server.emit("error", Object.assign(new Error("something else"), { code: "EOTHER" }));
    });
    expect(other).toBe("something else");
  });
});
