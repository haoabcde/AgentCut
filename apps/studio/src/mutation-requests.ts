export interface MutationRequestTicket {
  scope: string;
  payloadFingerprint: string;
  requestId: string;
}

interface PendingMutationRequest extends MutationRequestTicket {}

export class MutationOutcomeUnknownError extends Error {
  constructor(
    readonly scope: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MutationOutcomeUnknownError";
  }
}

/**
 * Keeps one caller-owned request ID for an unresolved logical write. A different
 * payload in the same scope is rejected until the first outcome is known, so an
 * ambiguous candidate accept cannot be followed by a contradictory keep.
 */
export class MutationRequestRegistry {
  readonly #pending = new Map<string, PendingMutationRequest>();
  readonly #createRequestId: () => string;

  constructor(createRequestId: () => string = () => crypto.randomUUID()) {
    this.#createRequestId = createRequestId;
  }

  acquire(scope: string, payload: unknown): MutationRequestTicket {
    const normalizedScope = requiredScope(scope);
    const payloadFingerprint = canonicalJson(payload);
    const current = this.#pending.get(normalizedScope);
    if (current) {
      if (current.payloadFingerprint !== payloadFingerprint) {
        throw new MutationOutcomeUnknownError(
          normalizedScope,
          "上一项写入结果尚未确认，不能在同一对象上提交不同操作；请先重试原操作或刷新工程状态。",
        );
      }
      return { ...current };
    }
    const requestId = this.#createRequestId();
    if (!requestId.trim()) throw new TypeError("Mutation request ID must not be empty");
    const ticket = { scope: normalizedScope, payloadFingerprint, requestId };
    this.#pending.set(normalizedScope, ticket);
    return { ...ticket };
  }

  confirm(ticket: MutationRequestTicket): void {
    const current = this.#pending.get(ticket.scope);
    if (sameTicket(current, ticket)) this.#pending.delete(ticket.scope);
  }

  fail(ticket: MutationRequestTicket, error: unknown): void {
    if (isAuthoritativeHttpFailure(error)) this.confirm(ticket);
  }

  clearScope(scope: string): void {
    this.#pending.delete(scope);
  }

  pendingRequestId(scope: string): string | undefined {
    return this.#pending.get(scope)?.requestId;
  }
}

export async function runStableMutation<T>(
  registry: MutationRequestRegistry,
  scope: string,
  payload: unknown,
  operation: (requestId: string) => Promise<T>,
): Promise<T> {
  const ticket = registry.acquire(scope, payload);
  try {
    const result = await operation(ticket.requestId);
    registry.confirm(ticket);
    return result;
  } catch (error) {
    registry.fail(ticket, error);
    if (isAuthoritativeHttpFailure(error) || error instanceof MutationOutcomeUnknownError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new MutationOutcomeUnknownError(
      ticket.scope,
      `${message} 写入结果尚未确认；重试同一操作会复用原 requestId。`,
      { cause: error },
    );
  }
}

function isAuthoritativeHttpFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
}

function sameTicket(
  current: PendingMutationRequest | undefined,
  ticket: MutationRequestTicket,
): boolean {
  return current?.requestId === ticket.requestId
    && current.payloadFingerprint === ticket.payloadFingerprint;
}

function requiredScope(value: string): string {
  const scope = value.trim();
  if (!scope) throw new TypeError("Mutation request scope must not be empty");
  return scope;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  if (value === undefined) return null;
  if (typeof value === "string" || typeof value === "number"
    || typeof value === "boolean" || value === null) return value;
  throw new TypeError(`Mutation request payload contains unsupported ${typeof value}`);
}
