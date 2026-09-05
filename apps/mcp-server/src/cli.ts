#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { AgentSessionCredential } from "@agentcut/agent-client";
import { createAgentCutMcpServer } from "./server.js";

const delegatedSession = readDelegatedSession(process.env.AGENTCUT_AGENT_SESSION_CREDENTIAL);

const handle = serveStdio(
  () => createAgentCutMcpServer(
    {
      ...(process.env.AGENTCUT_DAEMON_URL ? { baseUrl: process.env.AGENTCUT_DAEMON_URL } : {}),
      ...(process.env.AGENTCUT_AGENT_BOOTSTRAP_TOKEN
        ? { bootstrapToken: process.env.AGENTCUT_AGENT_BOOTSTRAP_TOKEN }
        : {}),
      ...(delegatedSession ? { session: delegatedSession } : {}),
    },
  ),
  {
    onerror(error) {
      process.stderr.write(`[agentcut-mcp] ${error.message}\n`);
    },
  },
);

let closing = false;
async function close(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await handle.close();
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`[agentcut-mcp] Failed to close after ${signal}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 7;
  }
}

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

function readDelegatedSession(value: string | undefined): AgentSessionCredential | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("AGENTCUT_AGENT_SESSION_CREDENTIAL is not valid base64url JSON");
  }
  if (!parsed || typeof parsed !== "object" || !("session" in parsed) || !("accessToken" in parsed)) {
    throw new Error("AGENTCUT_AGENT_SESSION_CREDENTIAL has an invalid schema");
  }
  const credential = parsed as Partial<AgentSessionCredential>;
  if (typeof credential.accessToken !== "string"
    || !credential.session || typeof credential.session !== "object"
    || typeof credential.session.id !== "string") {
    throw new Error("AGENTCUT_AGENT_SESSION_CREDENTIAL has an invalid schema");
  }
  return credential as AgentSessionCredential;
}
