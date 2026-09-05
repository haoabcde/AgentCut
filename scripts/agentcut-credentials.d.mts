export interface UiCredentialRotation {
  requestId: string;
  previousFingerprint: string;
  currentFingerprint: string;
  generation: number;
  rotatedAt: string;
}

export interface UiCredential {
  schemaVersion: "0.1.0" | "0.2.0";
  projectRoot: string;
  bootstrapToken: string;
  bootstrapFingerprint: string;
  generation: number;
  createdAt: string;
  lastRotation?: UiCredentialRotation;
}

export const AGENT_CREDENTIAL_RELATIVE_PATH: string;
export const UI_CREDENTIAL_RELATIVE_PATH: string;
export const AGENT_HANDOFF_SCHEMA_VERSION: "0.1.0";

export class AgentCredentialError extends Error {
  code: string;
}

export function ensureAgentCredentialFile(projectRoot: string): {
  credentialPath: string;
  projectRoot: string;
  bootstrapToken: string;
};

export function ensureUiCredentialFile(projectRoot: string): UiCredential & {
  credentialPath: string;
};

export function readUiCredentialFile(
  credentialPath: string,
  expectedProjectRoot?: string,
): UiCredential;

export function rotateUiCredentialFile(
  credentialPath: string,
  expectedProjectRoot: string,
  options: {
    requestId: string;
    clock?: () => string;
    tokenFactory?: () => string;
    afterPublish?: () => void;
  },
): {
  credential: UiCredential;
  rotation: UiCredentialRotation;
  idempotentReplay: boolean;
};

export function loadAgentBootstrapToken(environment?: Record<string, string | undefined>): string;

export interface AgentSessionHandoffCredential {
  schemaVersion: "0.1.0";
  credentialType: "agent-session";
  daemonUrl: string;
  projectId: string;
  session: {
    id: string;
    projectId: string;
    clientId: string;
    capabilities: Array<
      | "project:read"
      | "transcript:read"
      | "analysis:local"
      | "analysis:propose"
      | "timeline:write:low_risk_only"
      | "approval:request"
      | "timeline:write:approved"
      | "export:write"
    >;
    createdAt: string;
    expiresAt: string;
  };
  accessToken: string;
  accessTokenFingerprint: string;
  createdAt: string;
}

export function loadAgentCredential(environment?: Record<string, string | undefined>):
  | { kind: "bootstrap"; bootstrapToken: string }
  | {
      kind: "session";
      daemonUrl: string;
      credential: {
        session: AgentSessionHandoffCredential["session"];
        accessToken: string;
      };
    };

export function writeAgentHandoffCredentialFile(
  outputPath: string,
  input: {
    daemonUrl: string;
    credential: {
      session: AgentSessionHandoffCredential["session"];
      accessToken: string;
    };
  },
): {
  credentialPath: string;
  credential: AgentSessionHandoffCredential;
  idempotentReplay: boolean;
};

export function readAgentHandoffCredentialFile(
  credentialPath: string,
): AgentSessionHandoffCredential;
