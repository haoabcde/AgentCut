import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LmStudioSemanticReviewProvider } from "@agentcut/candidate-engine";
import { createAgentCutServer } from "./server.js";

const databasePath = process.env.AGENTCUT_PROJECT_DB;
const projectRoot = process.env.AGENTCUT_PROJECT_ROOT;
const port = Number(process.env.AGENTCUT_PORT ?? 4317);
const bundledStudioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../studio/dist");
const semanticModel = process.env.AGENTCUT_SEMANTIC_MODEL;
const uiBootstrapToken = process.env.AGENTCUT_UI_BOOTSTRAP_TOKEN;
const uiCredentialPath = process.env.AGENTCUT_UI_CREDENTIAL_PATH;
if (!databasePath || !projectRoot) {
  throw new Error("AGENTCUT_PROJECT_DB and AGENTCUT_PROJECT_ROOT are required");
}
if (!uiBootstrapToken && !uiCredentialPath) {
  throw new Error(
    "AGENTCUT_UI_CREDENTIAL_PATH is required for rotatable Studio write authorization",
  );
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("AGENTCUT_PORT must be a valid TCP port");
}
const server = createAgentCutServer({
  databasePath,
  projectRoot,
  allowedOrigin: process.env.AGENTCUT_ALLOWED_ORIGIN ?? "http://127.0.0.1:5173",
  ...(existsSync(bundledStudioRoot) ? { studioRoot: bundledStudioRoot } : {}),
  ...(semanticModel ? {
    semanticReviewProvider: new LmStudioSemanticReviewProvider({
      baseUrl: process.env.AGENTCUT_SEMANTIC_BASE_URL ?? "http://127.0.0.1:1234/v1",
      model: semanticModel,
      timeoutMs: 180_000,
    }),
  } : {}),
  ...(process.env.AGENTCUT_AGENT_BOOTSTRAP_TOKEN
    ? { agentBootstrapToken: process.env.AGENTCUT_AGENT_BOOTSTRAP_TOKEN }
    : {}),
  ...(uiCredentialPath ? { uiCredentialPath } : { uiBootstrapToken: uiBootstrapToken! }),
});
server.listen(port, "127.0.0.1", () => {
  console.log(`AgentCut local daemon listening on http://127.0.0.1:${port}`);
});
