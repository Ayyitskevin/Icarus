import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";

export interface CapturedProviderRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface ProviderHttpServer {
  readonly baseUrl: string;
  readonly requests: CapturedProviderRequest[];
  close(): Promise<void>;
}

type ProviderRequestHandler = (
  request: CapturedProviderRequest,
  response: ServerResponse,
) => void | Promise<void>;

export async function startProviderHttpServer(
  handler: ProviderRequestHandler,
): Promise<ProviderHttpServer> {
  const requests: CapturedProviderRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const captured: CapturedProviderRequest = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      await handler(captured, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }
      response.end(error instanceof Error ? error.message : "provider test server error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Provider test server did not bind a TCP address");
  }

  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      const closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      server.closeAllConnections();
      await closePromise;
    },
  };
}

export function sendProviderJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export function parseProviderRequestBody(request: CapturedProviderRequest): unknown {
  return JSON.parse(request.body) as unknown;
}
