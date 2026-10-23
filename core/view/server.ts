/**
 * @file The local server behind `nilometer view` (D-097, step G6.2).
 *
 * A saved page is a file, and a browser won't let a file run programs, so a Refresh button on it can't
 * ingest. While `view` runs, this server shows the page on 127.0.0.1 and, when the page asks, ingests and
 * rebuilds it. It's the only way in, so it accepts as little as it can:
 * - it listens on the loopback address only, never on a network interface;
 * - every path starts with a random token made for this run, so another page in the browser can't guess it;
 * - the Host header must name this server, which defeats DNS rebinding, where a site re-points its own
 *   name at 127.0.0.1;
 * - a refresh must be a POST from this server's own origin, which a page on another site can't send;
 * - it serves one page and does one thing, refresh; anything else is a 404.
 */
import { timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

/** What a request asks for, once checked. */
export type Route =
  | { readonly kind: "page" }
  | { readonly kind: "refresh" }
  | { readonly kind: "refuse"; readonly status: 403 | 404 | 405; readonly reason: string };

/** The parts of a request {@link route} reads. */
export interface RequestFacts {
  /** HTTP method. */
  readonly method: string;
  /** The request target, path and query. */
  readonly url: string;
  /** The Host header, if any. */
  readonly host: string | undefined;
  /** The Origin header, if any. */
  readonly origin: string | undefined;
}

/**
 * The hosts this server answers to: the loopback address and `localhost`, on its own port.
 * @param port - The port it listens on.
 * @returns Host header values, without a scheme.
 */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/**
 * Compares two strings in time that doesn't depend on where they differ.
 * @param a - One string.
 * @param b - The other.
 * @returns Whether they're equal.
 */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Decides what a request may do.
 * @param request - Method, target, Host and Origin.
 * @param token - This run's token.
 * @param port - The port this server listens on.
 * @returns The page, a refresh, or a refusal with its status.
 */
export function route(request: RequestFacts, token: string, port: number): Route {
  const hosts = allowedHosts(port);
  if (request.host === undefined || !hosts.includes(request.host.toLowerCase())) {
    return { kind: "refuse", status: 403, reason: "unknown host" };
  }
  // Only the path counts; a query string never changes what's served.
  const path = request.url.split("?")[0] ?? "";
  const match = /^\/([^/]+)\/(refresh)?$/.exec(path);
  if (match === null || !sameSecret(match[1] ?? "", token)) {
    return { kind: "refuse", status: 404, reason: "not found" };
  }
  if (match[2] === undefined) {
    return request.method === "GET" || request.method === "HEAD"
      ? { kind: "page" }
      : { kind: "refuse", status: 405, reason: "the page is only read" };
  }
  if (request.method !== "POST") {
    return { kind: "refuse", status: 405, reason: "a refresh is a POST" };
  }
  // A browser sends Origin with every POST from a page; none, or another one, isn't this page.
  if (request.origin === undefined || !hosts.map((h) => `http://${h}`).includes(request.origin)) {
    return { kind: "refuse", status: 403, reason: "a refresh must come from this page" };
  }
  return { kind: "refresh" };
}

/**
 * Headers for every response. The policy lets the page run its own inline script and style and talk
 * only to this server; the token stays out of any Referer.
 */
export const RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** What a refresh reports back to the page. */
export interface RefreshResult {
  /** Whether the page was rebuilt. */
  readonly ok: boolean;
  /** One line for the page's status line. */
  readonly message: string;
}

/** What the server needs. */
export interface ViewServerDeps {
  /** This run's token. */
  readonly token: string;
  /** The current page. */
  readonly page: () => string;
  /** Ingests and rebuilds the page. Runs to completion before the response, one at a time. */
  readonly refresh: () => RefreshResult;
}

/**
 * Creates the server, not yet listening. Listen on 127.0.0.1 only.
 * @param deps - Token, page, and refresh.
 * @returns The server.
 */
export function createViewServer(deps: ViewServerDeps): Server {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const decided = route(
      {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        host: request.headers.host,
        origin: request.headers.origin,
      },
      deps.token,
      port,
    );
    // The body is never read: no route takes one.
    request.resume();
    if (decided.kind === "refuse") {
      response.writeHead(decided.status, {
        ...RESPONSE_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end(`${decided.reason}\n`);
      return;
    }
    if (decided.kind === "page") {
      response.writeHead(200, { ...RESPONSE_HEADERS, "Content-Type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : deps.page());
      return;
    }
    let result: RefreshResult;
    try {
      result = deps.refresh();
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    response.writeHead(result.ok ? 200 : 500, {
      ...RESPONSE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(result));
  });
  return server;
}

/** What {@link listenView} needs besides the server's own deps. */
export interface ListenOptions extends ViewServerDeps {
  /** Port on 127.0.0.1; 0 picks a free one. */
  readonly port: number;
  /** Called once listening, with the page's address. */
  readonly onListening: (url: string) => void;
  /** Called if the server can't listen or fails, with what went wrong. */
  readonly onError: (message: string) => void;
}

/**
 * Starts the server on the loopback address only. It runs until the process ends (Ctrl+C).
 * @param options - Token, page, refresh, port, and callbacks.
 * @returns The listening server.
 */
export function listenView(options: ListenOptions): Server {
  const server = createViewServer(options);
  server.on("error", (error: NodeJS.ErrnoException) => {
    options.onError(
      error.code === "EADDRINUSE"
        ? `port ${options.port} on 127.0.0.1 is in use; choose another with --port, or leave it out for any free port`
        : error.message,
    );
  });
  // 127.0.0.1 explicitly: listening on every interface would put the page on the network.
  server.listen(options.port, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    options.onListening(`http://127.0.0.1:${port}/${options.token}/`);
  });
  return server;
}
