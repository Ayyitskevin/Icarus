import http from "node:http";

import type { StartedWorkspaceServer } from "../../packages/api/src/server.js";

function requestBody(body: BodyInit | null | undefined): Buffer | string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error("Workspace test transport received an unsupported request body");
}

/**
 * Exercise the exact browser origin while connecting directly to the verified
 * loopback listener. Browser resolution is proven separately by real-browser
 * smokes; native HTTP tests must not mistake the operating-system resolver for
 * the browser's built-in `.localhost` handling.
 */
export async function fetchWorkspace(
  workspace: StartedWorkspaceServer,
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(input, workspace.url);
  if (url.origin !== workspace.url) {
    throw new Error("Workspace test transport cannot leave the exact browser origin");
  }

  const headers = new Headers(init.headers);
  headers.set("host", new URL(workspace.url).host);
  const body = requestBody(init.body);

  return new Promise<Response>((resolve, reject) => {
    const request = http.request(
      {
        hostname: workspace.host,
        port: workspace.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const responseHeaders = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            responseHeaders.append(
              response.rawHeaders[index] ?? "",
              response.rawHeaders[index + 1] ?? "",
            );
          }
          const bytes = Buffer.concat(chunks);
          const status = response.statusCode ?? 500;
          resolve(
            new Response(status === 204 || status === 304 ? null : bytes, {
              status,
              ...(response.statusMessage === undefined
                ? {}
                : { statusText: response.statusMessage }),
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    request.once("error", (error) => {
      reject(
        new Error(
          `Workspace test transport failed for ${init.method ?? "GET"} ${url.pathname}: ${error.message}`,
          { cause: error },
        ),
      );
    });
    if (init.signal !== undefined && init.signal !== null) {
      if (init.signal.aborted) {
        request.destroy(init.signal.reason);
      } else {
        init.signal.addEventListener("abort", () => request.destroy(init.signal?.reason), {
          once: true,
        });
      }
    }
    if (body !== undefined) request.write(body);
    request.end();
  });
}
