import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface WorkerHealthServer {
  port: number;
  close(): Promise<void>;
}

export async function startWorkerHealthServer(options: {
  host: string;
  port: number;
}): Promise<WorkerHealthServer> {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
