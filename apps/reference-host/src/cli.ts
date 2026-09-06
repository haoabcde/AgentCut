#!/usr/bin/env node
const databasePath = process.env.REFERENCE_HOST_DB;
const bootstrapToken = process.env.REFERENCE_HOST_BOOTSTRAP_TOKEN;
const port = Number(process.env.REFERENCE_HOST_PORT ?? 4318);
if (!databasePath) {
  throw new Error("REFERENCE_HOST_DB is required");
}
if (!bootstrapToken) {
  throw new Error("REFERENCE_HOST_BOOTSTRAP_TOKEN is required");
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("REFERENCE_HOST_PORT must be a valid TCP port");
}

const { createReferenceHost } = await import("./server.js");
const server = createReferenceHost({
  databasePath,
  agentBootstrapToken: bootstrapToken,
  allowedOrigin: process.env.REFERENCE_HOST_ALLOWED_ORIGIN,
});
server.listen(port, "127.0.0.1", () => {
  console.log(`AgentCut reference host listening on http://127.0.0.1:${port}`);
});
