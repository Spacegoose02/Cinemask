import type { z } from 'zod';
import { HttpError } from './errors.js';

/** Parses untrusted input, turning validation failures into a 400 with field messages. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
    throw new HttpError(400, detail || 'Invalid request', 'validation');
  }
  return result.data;
}
