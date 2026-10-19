export interface ErrorDetail {
  path: string;
  message: string;
}

/** Base class for errors that map directly to an HTTP response. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: ErrorDetail[], code = 'VALIDATION_ERROR') {
    super(400, code, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code = 'NOT_FOUND') {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT') {
    super(409, code, message);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message: string) {
    super(415, 'UNSUPPORTED_MEDIA_TYPE', message);
  }
}
