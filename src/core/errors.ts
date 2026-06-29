export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
    readonly meta?: unknown,
  ) {
    super(message ?? code);
    this.name = new.target.name;
  }
}
export class NotFoundError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("NotFoundError", 404, message, meta);
  }
}
export class ForbiddenError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("ForbiddenError", 403, message, meta);
  }
}
export class ConflictError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("ConflictError", 409, message, meta);
  }
}
export class ValidationError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("ValidationError", 422, message, meta);
  }
}
export class SettlementInvariantError extends AppError {
  constructor(message?: string, meta?: unknown) {
    super("SettlementInvariantError", 422, message, meta);
  }
}
