export type EditErrorCode =
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "PROJECT_MISMATCH"
  | "SEQUENCE_NOT_FOUND"
  | "OBJECT_NOT_FOUND"
  | "DUPLICATE_ID"
  | "LOCKED"
  | "PRECONDITION_FAILED"
  | "INVALID_OPERATION"
  | "INVALID_DOCUMENT";

export class EditError extends Error {
  constructor(
    readonly code: EditErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EditError";
  }
}
