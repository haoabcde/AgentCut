import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const AGENT_CREDENTIAL_RELATIVE_PATH = ".agentcut-runtime/agent-access.json";
export const UI_CREDENTIAL_RELATIVE_PATH = ".agentcut-runtime/ui-access.json";
export const AGENT_HANDOFF_SCHEMA_VERSION = "0.1.0";

export class AgentCredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentCredentialError";
    this.code = code;
  }
}

export function ensureAgentCredentialFile(projectRoot) {
  const normalizedRoot = resolve(projectRoot);
  const credentialPath = join(normalizedRoot, AGENT_CREDENTIAL_RELATIVE_PATH);
  mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(credentialPath), 0o700);
  if (!existsSync(credentialPath)) {
    const document = {
      schemaVersion: "0.1.0",
      projectRoot: normalizedRoot,
      bootstrapToken: randomBytes(32).toString("base64url"),
      createdAt: new Date().toISOString(),
    };
    let descriptor;
    try {
      descriptor = openSync(credentialPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    } catch (error) {
      if (!existsSync(credentialPath)) throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  chmodSync(credentialPath, 0o600);
  return { credentialPath, ...readCredentialFile(credentialPath, normalizedRoot) };
}

export function ensureUiCredentialFile(projectRoot) {
  const normalizedRoot = resolve(projectRoot);
  const credentialPath = join(normalizedRoot, UI_CREDENTIAL_RELATIVE_PATH);
  mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(credentialPath), 0o700);
  if (!existsSync(credentialPath)) {
    const document = {
      schemaVersion: "0.1.0",
      projectRoot: normalizedRoot,
      bootstrapToken: randomBytes(32).toString("base64url"),
      createdAt: new Date().toISOString(),
    };
    let descriptor;
    try {
      descriptor = openSync(credentialPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    } catch (error) {
      if (!existsSync(credentialPath)) throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  chmodSync(credentialPath, 0o600);
  return { credentialPath, ...readUiCredentialFile(credentialPath, normalizedRoot) };
}

export function readUiCredentialFile(credentialPath, expectedProjectRoot) {
  const value = readCredentialDocument(credentialPath);
  if (!value || typeof value !== "object"
    || (value.schemaVersion !== "0.1.0" && value.schemaVersion !== "0.2.0")
    || typeof value.projectRoot !== "string" || typeof value.bootstrapToken !== "string"
    || typeof value.createdAt !== "string") {
    throw new AgentCredentialError("AGENT_CREDENTIALS_INVALID", "UI credential file has an invalid schema");
  }
  const projectRoot = resolve(value.projectRoot);
  if (expectedProjectRoot && projectRoot !== resolve(expectedProjectRoot)) {
    throw new AgentCredentialError(
      "AGENT_CREDENTIALS_INVALID",
      "UI credential file is bound to another project root",
    );
  }
  const bootstrapToken = validateToken(value.bootstrapToken);
  const bootstrapFingerprint = fingerprintToken(bootstrapToken);
  const generation = value.schemaVersion === "0.2.0" ? value.generation : 0;
  if (!Number.isSafeInteger(generation) || generation < 0
    || (value.bootstrapFingerprint !== undefined
      && value.bootstrapFingerprint !== bootstrapFingerprint)) {
    throw new AgentCredentialError("AGENT_CREDENTIALS_INVALID", "UI credential rotation metadata is invalid");
  }
  let lastRotation;
  if (value.lastRotation !== undefined) {
    const rotation = value.lastRotation;
    if (!rotation || typeof rotation !== "object"
      || typeof rotation.requestId !== "string"
      || typeof rotation.previousFingerprint !== "string"
      || rotation.currentFingerprint !== bootstrapFingerprint
      || rotation.generation !== generation
      || typeof rotation.rotatedAt !== "string"
      || !Number.isFinite(Date.parse(rotation.rotatedAt))) {
      throw new AgentCredentialError("AGENT_CREDENTIALS_INVALID", "UI credential lastRotation is invalid");
    }
    lastRotation = {
      requestId: rotation.requestId,
      previousFingerprint: rotation.previousFingerprint,
      currentFingerprint: rotation.currentFingerprint,
      generation: rotation.generation,
      rotatedAt: rotation.rotatedAt,
    };
  }
  return {
    schemaVersion: value.schemaVersion,
    projectRoot,
    bootstrapToken,
    bootstrapFingerprint,
    generation,
    createdAt: value.createdAt,
    ...(lastRotation ? { lastRotation } : {}),
  };
}

export function rotateUiCredentialFile(credentialPath, expectedProjectRoot, options) {
  const requestId = options?.requestId;
  if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 128
    || requestId !== requestId.trim()) {
    throw new AgentCredentialError(
      "UI_CREDENTIAL_ROTATION_INVALID",
      "UI credential rotation requestId must contain 8-128 stable characters",
    );
  }
  const current = readUiCredentialFile(credentialPath, expectedProjectRoot);
  if (current.lastRotation?.requestId === requestId) {
    return { credential: current, rotation: current.lastRotation, idempotentReplay: true };
  }
  const rotatedAt = options?.clock?.() ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(rotatedAt))) {
    throw new AgentCredentialError("UI_CREDENTIAL_ROTATION_INVALID", "UI credential rotation clock is invalid");
  }
  const bootstrapToken = options?.tokenFactory?.() ?? randomBytes(32).toString("base64url");
  validateToken(bootstrapToken);
  if (bootstrapToken === current.bootstrapToken) {
    throw new AgentCredentialError(
      "UI_CREDENTIAL_ROTATION_INVALID",
      "UI credential rotation must generate a different bootstrap token",
    );
  }
  const generation = current.generation + 1;
  const currentFingerprint = fingerprintToken(bootstrapToken);
  const rotation = {
    requestId,
    previousFingerprint: current.bootstrapFingerprint,
    currentFingerprint,
    generation,
    rotatedAt,
  };
  const document = {
    schemaVersion: "0.2.0",
    projectRoot: current.projectRoot,
    bootstrapToken,
    bootstrapFingerprint: currentFingerprint,
    generation,
    createdAt: current.createdAt,
    rotatedAt,
    lastRotation: rotation,
  };
  writeCredentialAtomically(resolve(credentialPath), document);
  options?.afterPublish?.();
  return {
    credential: readUiCredentialFile(credentialPath, expectedProjectRoot),
    rotation,
    idempotentReplay: false,
  };
}

export function loadAgentBootstrapToken(environment = process.env) {
  const credential = loadAgentCredential(environment);
  if (credential.kind !== "bootstrap") {
    throw new AgentCredentialError(
      "AGENT_CREDENTIALS_INVALID",
      "This command requires a project bootstrap credential, not a delegated Agent session",
    );
  }
  return credential.bootstrapToken;
}

export function loadAgentCredential(environment = process.env) {
  if (environment.AGENTCUT_AGENT_BOOTSTRAP_TOKEN) {
    return {
      kind: "bootstrap",
      bootstrapToken: validateToken(environment.AGENTCUT_AGENT_BOOTSTRAP_TOKEN),
    };
  }
  const credentialPath = environment.AGENTCUT_AGENT_CREDENTIALS
    ?? (environment.AGENTCUT_PROJECT_ROOT
      ? join(resolve(environment.AGENTCUT_PROJECT_ROOT), AGENT_CREDENTIAL_RELATIVE_PATH)
      : undefined);
  if (!credentialPath) {
    throw new AgentCredentialError(
      "AGENT_CREDENTIALS_MISSING",
      "Set AGENTCUT_AGENT_CREDENTIALS or AGENTCUT_PROJECT_ROOT to the project started by AgentCut Studio",
    );
  }
  const document = readCredentialDocument(resolve(credentialPath));
  if (document?.credentialType === "agent-session") {
    const handoff = readAgentHandoffCredentialFile(resolve(credentialPath));
    return {
      kind: "session",
      daemonUrl: handoff.daemonUrl,
      credential: {
        session: handoff.session,
        accessToken: handoff.accessToken,
      },
    };
  }
  return {
    kind: "bootstrap",
    bootstrapToken: readCredentialFile(resolve(credentialPath)).bootstrapToken,
  };
}

export function writeAgentHandoffCredentialFile(outputPath, input) {
  const credentialPath = resolve(outputPath);
  const document = buildAgentHandoffCredential(input);
  if (existsSync(credentialPath)) {
    const existing = parseAgentHandoffCredential(readCredentialDocument(credentialPath), credentialPath);
    if (JSON.stringify(existing) !== JSON.stringify(document)) {
      throw new AgentCredentialError(
        "AGENT_HANDOFF_EXISTS",
        `Refusing to overwrite another Agent handoff credential at ${credentialPath}`,
      );
    }
    assertPrivateCredentialMode(credentialPath);
    return { credentialPath, credential: existing, idempotentReplay: true };
  }
  const directory = dirname(credentialPath);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new AgentCredentialError(
      "AGENT_HANDOFF_PATH_INVALID",
      `Agent handoff parent directory does not exist: ${directory}`,
    );
  }
  const temporaryPath = join(
    directory,
    `.${credentialPath.slice(credentialPath.lastIndexOf("/") + 1)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporaryPath, credentialPath);
    } catch (error) {
      if (!existsSync(credentialPath)) throw error;
      const existing = parseAgentHandoffCredential(readCredentialDocument(credentialPath), credentialPath);
      if (JSON.stringify(existing) !== JSON.stringify(document)) {
        throw new AgentCredentialError(
          "AGENT_HANDOFF_EXISTS",
          `Refusing to overwrite another Agent handoff credential at ${credentialPath}`,
        );
      }
      assertPrivateCredentialMode(credentialPath);
      return { credentialPath, credential: existing, idempotentReplay: true };
    }
    chmodSync(credentialPath, 0o600);
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    return { credentialPath, credential: document, idempotentReplay: false };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function readAgentHandoffCredentialFile(credentialPath) {
  const normalizedPath = resolve(credentialPath);
  assertPrivateCredentialMode(normalizedPath);
  return parseAgentHandoffCredential(readCredentialDocument(normalizedPath), normalizedPath);
}

function readCredentialFile(credentialPath, expectedProjectRoot) {
  const value = readCredentialDocument(credentialPath);
  if (!value || typeof value !== "object" || value.schemaVersion !== "0.1.0"
    || typeof value.projectRoot !== "string" || typeof value.bootstrapToken !== "string") {
    throw new AgentCredentialError("AGENT_CREDENTIALS_INVALID", "Agent credential file has an invalid schema");
  }
  if (expectedProjectRoot && resolve(value.projectRoot) !== expectedProjectRoot) {
    throw new AgentCredentialError(
      "AGENT_CREDENTIALS_INVALID",
      "Agent credential file is bound to another project root",
    );
  }
  return {
    projectRoot: resolve(value.projectRoot),
    bootstrapToken: validateToken(value.bootstrapToken),
  };
}

function readCredentialDocument(credentialPath) {
  try {
    return JSON.parse(readFileSync(credentialPath, "utf8"));
  } catch (error) {
    throw new AgentCredentialError(
      "AGENT_CREDENTIALS_INVALID",
      `Cannot read Agent credential file ${credentialPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function buildAgentHandoffCredential(input) {
  if (!input || typeof input !== "object") {
    throw new AgentCredentialError("AGENT_HANDOFF_INVALID", "Agent handoff input is invalid");
  }
  const daemonUrl = normalizeLocalDaemonUrl(input.daemonUrl);
  const credential = input.credential;
  if (!credential || typeof credential !== "object") {
    throw new AgentCredentialError("AGENT_HANDOFF_INVALID", "Agent handoff session credential is missing");
  }
  const session = validateAgentSessionDescriptor(credential.session);
  const accessToken = validateSessionToken(credential.accessToken);
  return {
    schemaVersion: AGENT_HANDOFF_SCHEMA_VERSION,
    credentialType: "agent-session",
    daemonUrl,
    projectId: session.projectId,
    session,
    accessToken,
    accessTokenFingerprint: fingerprintToken(accessToken),
    createdAt: session.createdAt,
  };
}

function parseAgentHandoffCredential(value, credentialPath) {
  if (!value || typeof value !== "object"
    || value.schemaVersion !== AGENT_HANDOFF_SCHEMA_VERSION
    || value.credentialType !== "agent-session") {
    throw new AgentCredentialError(
      "AGENT_HANDOFF_INVALID",
      `Agent handoff credential has an invalid schema: ${credentialPath}`,
    );
  }
  const document = buildAgentHandoffCredential({
    daemonUrl: value.daemonUrl,
    credential: { session: value.session, accessToken: value.accessToken },
  });
  if (value.projectId !== document.projectId
    || value.accessTokenFingerprint !== document.accessTokenFingerprint
    || value.createdAt !== document.createdAt) {
    throw new AgentCredentialError(
      "AGENT_HANDOFF_INVALID",
      `Agent handoff credential integrity metadata is invalid: ${credentialPath}`,
    );
  }
  return document;
}

function validateAgentSessionDescriptor(value) {
  const allowedCapabilities = new Set([
    "project:read",
    "transcript:read",
    "analysis:local",
    "analysis:propose",
    "timeline:write:low_risk_only",
    "approval:request",
    "timeline:write:approved",
    "export:write",
  ]);
  if (!value || typeof value !== "object"
    || typeof value.id !== "string" || !value.id.trim() || value.id !== value.id.trim()
    || typeof value.projectId !== "string" || !value.projectId.trim()
    || value.projectId !== value.projectId.trim()
    || typeof value.clientId !== "string" || !value.clientId.trim()
    || value.clientId !== value.clientId.trim()
    || !Array.isArray(value.capabilities) || value.capabilities.length === 0
    || new Set(value.capabilities).size !== value.capabilities.length
    || value.capabilities.some((capability) => !allowedCapabilities.has(capability))
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
    || value.revokedAt !== undefined) {
    throw new AgentCredentialError("AGENT_HANDOFF_INVALID", "Agent handoff session descriptor is invalid");
  }
  return {
    id: value.id,
    projectId: value.projectId,
    clientId: value.clientId,
    capabilities: [...value.capabilities],
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function validateSessionToken(value) {
  if (typeof value !== "string" || !/^agc_[A-Za-z0-9_-]{32,}$/.test(value)) {
    throw new AgentCredentialError("AGENT_HANDOFF_INVALID", "Agent handoff access token is invalid");
  }
  return value;
}

function normalizeLocalDaemonUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AgentCredentialError("AGENT_HANDOFF_INVALID", "Agent handoff daemonUrl is invalid");
  }
  if (url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) {
    throw new AgentCredentialError(
      "AGENT_HANDOFF_INVALID",
      "Agent handoff daemonUrl must be a plain loopback HTTP origin",
    );
  }
  return url.origin;
}

function assertPrivateCredentialMode(credentialPath) {
  let status;
  try {
    status = lstatSync(credentialPath);
  } catch (error) {
    throw new AgentCredentialError(
      "AGENT_HANDOFF_INVALID",
      `Cannot stat Agent handoff credential ${credentialPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!status.isFile() || (status.mode & 0o077) !== 0) {
    throw new AgentCredentialError(
      "AGENT_HANDOFF_PERMISSIONS",
      "Agent handoff credential must be a regular file without group or world permissions",
    );
  }
}

function writeCredentialAtomically(credentialPath, document) {
  const directory = dirname(credentialPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = join(
    directory,
    `.${credentialPath.slice(credentialPath.lastIndexOf("/") + 1)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, credentialPath);
    chmodSync(credentialPath, 0o600);
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function fingerprintToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function validateToken(token) {
  if (Buffer.byteLength(token, "utf8") < 32 || token !== token.trim()) {
    throw new AgentCredentialError(
      "AGENT_CREDENTIALS_INVALID",
      "Agent bootstrap token must contain at least 32 bytes without surrounding whitespace",
    );
  }
  return token;
}
