import { SECRET_ENV_NAMES } from '../config';

/** Redact secret values and key-like query parameters from any string before it is logged or stored. */
export function redact(input: string): string {
  let out = input.replace(/([?&](api_key|apikey|token|key|access_token)=)[^&\s"']+/gi, '$1[REDACTED]');
  out = out.replace(/(x-api-key|authorization)(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1$2[REDACTED]');
  out = out.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgres://[REDACTED]');
  for (const name of SECRET_ENV_NAMES) {
    const v = process.env[name];
    if (v && v.length >= 6) out = out.split(v).join('[REDACTED]');
  }
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, scope: string, msg: string, extra?: unknown) {
  if (level === 'debug' && !process.env.DEBUG) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope}: ${msg}${extra !== undefined ? ` ${safeJson(extra)}` : ''}`;
  const clean = redact(line);
  if (level === 'error') console.error(clean);
  else if (level === 'warn') console.warn(clean);
  else console.log(clean);
}

function safeJson(v: unknown): string {
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope = 'app'): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return redact(err.message);
  return redact(String(err));
}
