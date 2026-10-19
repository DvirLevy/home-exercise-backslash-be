import multer, { MulterError } from 'multer';
import type { RequestHandler } from 'express';
import { AppError, PayloadTooLargeError, UnsupportedMediaTypeError, ValidationError } from '../errors';

export const UPLOAD_FIELD = 'file';

export interface GraphFileUploadOptions {
  maxBytes: number;
}

/** JSON only: the file must be named *.json or be sent as application/json. */
function isJsonFile(file: Express.Multer.File): boolean {
  return file.mimetype === 'application/json' || /\.json$/i.test(file.originalname);
}

function translateUploadError(err: unknown, maxBytes: number): unknown {
  if (err instanceof AppError) return err;
  if (err instanceof MulterError) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return new PayloadTooLargeError(`The file is larger than the allowed ${maxBytes} bytes`);
      case 'LIMIT_UNEXPECTED_FILE':
        return new ValidationError(`Upload the file in the "${UPLOAD_FIELD}" field`, [
          { path: err.field ?? UPLOAD_FIELD, message: `Unexpected file field; expected "${UPLOAD_FIELD}"` },
        ]);
      default:
        return new ValidationError(`Invalid multipart request: ${err.message}`, [], 'INVALID_MULTIPART');
    }
  }
  // Malformed multipart bodies surface as plain Errors from the parser.
  if (err instanceof Error && /multipart|boundary|unexpected end/i.test(err.message)) {
    return new ValidationError(`Invalid multipart request: ${err.message}`, [], 'INVALID_MULTIPART');
  }
  return err;
}

/**
 * Reads one JSON file (field `file`) plus text fields from a multipart/form-data request into
 * memory. Afterwards `req.file` holds the file and `req.body` the text fields.
 */
export function graphFileUpload({ maxBytes }: GraphFileUploadOptions): RequestHandler {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 8 * 1024, parts: 12 },
    fileFilter: (_req, file, callback) => {
      if (isJsonFile(file)) {
        callback(null, true);
      } else {
        callback(new UnsupportedMediaTypeError('Only JSON files are accepted (.json or application/json)'));
      }
    },
  }).single(UPLOAD_FIELD);

  return (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      next(new UnsupportedMediaTypeError('Content-Type must be multipart/form-data'));
      return;
    }
    parse(req, res, (err: unknown) => next(err === undefined ? undefined : translateUploadError(err, maxBytes)));
  };
}
