import { createReadStream, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { runPipeline, defaultOutputDir } from "./run-demo.mjs";

const PORT = process.env.PORT ?? 4400;
const outputDir = process.env.SHORTS_OUTPUT_DIR ?? defaultOutputDir;
const webRoot = resolve(join(fileURLToPath(import.meta.url), "..", "..", "web"));

let job = null;

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function serveStaticFile(response, filePath, contentType) {
  response.writeHead(200, { "Content-Type": contentType });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.url === "/") {
    serveStaticFile(response, join(webRoot, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (request.url === "/api/run" && request.method === "POST") {
    if (job?.status === "running") {
      sendJson(response, 409, { error: "A job is already running" });
      return;
    }

    job = { status: "running", logs: [], report: null, error: null };
    runPipeline({ outputDir, onProgress: (event) => job.logs.push(event) })
      .then((report) => {
        job.status = "done";
        job.report = report;
      })
      .catch((error) => {
        job.status = "error";
        job.error = error.message;
      });

    sendJson(response, 202, { status: "started" });
    return;
  }

  if (request.url === "/api/status" && request.method === "GET") {
    sendJson(response, 200, job ?? { status: "idle", logs: [] });
    return;
  }

  if (request.url.startsWith("/clips/") && request.method === "GET") {
    const relative = decodeURIComponent(request.url.replace("/clips/", ""));
    const filePath = resolve(join(outputDir, relative));
    if (!filePath.startsWith(resolve(outputDir))) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const stats = statSync(filePath);
    const total = stats.size;
    const range = request.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunkSize = end - start + 1;
      response.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunkSize),
        "Content-Type": "video/mp4",
      });
      createReadStream(filePath, { start, end }).pipe(response);
    } else {
      response.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Content-Length": String(total),
        "Content-Type": "video/mp4",
      });
      createReadStream(filePath).pipe(response);
    }
    return;
  }

  response.writeHead(404);
  response.end("Not found");
});

server.listen(PORT, () => {
  console.log(`AI Shorts Demo UI: http://127.0.0.1:${PORT}`);
});
