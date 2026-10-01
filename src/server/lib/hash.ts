import crypto from 'node:crypto';

/** Deterministic JSON serialization (sorted keys) so equal content always hashes equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256(input: string | Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function contentHash(value: unknown): string {
  return sha256(typeof value === 'string' ? value : stableStringify(value));
}
