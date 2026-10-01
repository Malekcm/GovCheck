import { redact } from './logger';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Total attempts = retries + 1. */
  retries?: number;
  /** Minimum spacing between requests to the same host (politeness / rate limits). */
  hostDelayMs?: number;
  responseType?: 'json' | 'text' | 'buffer' | 'stream';
  /** Abort early if the response is larger than this (buffer/text). */
  maxBytes?: number;
  redirect?: 'follow' | 'manual';
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  url: string;
  data: T;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
    readonly retryable: boolean,
    readonly bodySnippet?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Anything that can perform HTTP requests. Connectors receive this so tests can inject fixtures. */
export interface HttpClient {
  request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function userAgent(contact?: string): string {
  return `GovOpportunityIntelligence/0.1 (+public-data research${contact ? `; contact ${contact}` : ''})`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class FetchHttpClient implements HttpClient {
  private nextAllowed = new Map<string, number>();

  constructor(private opts: { userAgent?: string; defaultTimeoutMs?: number } = {}) {}

  private async throttle(host: string, delayMs: number) {
    if (delayMs <= 0) return;
    const now = Date.now();
    const at = this.nextAllowed.get(host) ?? 0;
    const wait = Math.max(0, at - now);
    this.nextAllowed.set(host, Math.max(now, at) + delayMs);
    if (wait > 0) await sleep(wait);
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const retries = req.retries ?? 3;
    const timeoutMs = req.timeoutMs ?? this.opts.defaultTimeoutMs ?? 30_000;
    const host = new URL(req.url).host;
    const safeUrl = redact(req.url);
    let lastErr: HttpError | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.throttle(host, req.hostDelayMs ?? 250);
      let res: Response;
      try {
        res = await fetch(req.url, {
          method: req.method ?? 'GET',
          headers: { 'User-Agent': this.opts.userAgent ?? userAgent(), Accept: '*/*', ...req.headers },
          body: req.body,
          redirect: req.redirect ?? 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = /timeout|aborted/i.test(msg);
        lastErr = new HttpError(`${isTimeout ? 'Timed out' : 'Network error'} calling ${safeUrl}: ${redact(msg)}`, null, safeUrl, true);
        if (attempt < retries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw lastErr;
      }

      if (!res.ok && !(req.redirect === 'manual' && res.status >= 300 && res.status < 400)) {
        const snippet = redact((await res.text().catch(() => '')).slice(0, 400));
        const retryable = RETRYABLE_STATUS.has(res.status);
        lastErr = new HttpError(`HTTP ${res.status} from ${safeUrl}${snippet ? `: ${snippet}` : ''}`, res.status, safeUrl, retryable, snippet);
        if (retryable && attempt < retries) {
          const retryAfter = Number(res.headers.get('retry-after'));
          // Do not wait hours for daily-quota 429s; surface them instead.
          if (res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 120) throw lastErr;
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
          continue;
        }
        throw lastErr;
      }

      const type = req.responseType ?? 'json';
      if (type === 'stream') return { status: res.status, headers: res.headers, url: res.url, data: res.body as T };
      const len = Number(res.headers.get('content-length'));
      if (req.maxBytes && Number.isFinite(len) && len > req.maxBytes) {
        await res.body?.cancel();
        throw new HttpError(`Response too large (${len} bytes) from ${safeUrl}`, res.status, safeUrl, false);
      }
      if (type === 'buffer') {
        const buf = Buffer.from(await res.arrayBuffer());
        if (req.maxBytes && buf.length > req.maxBytes) throw new HttpError(`Response too large from ${safeUrl}`, res.status, safeUrl, false);
        return { status: res.status, headers: res.headers, url: res.url, data: buf as T };
      }
      const text = await res.text();
      if (type === 'text') return { status: res.status, headers: res.headers, url: res.url, data: text as T };
      try {
        return { status: res.status, headers: res.headers, url: res.url, data: (text ? JSON.parse(text) : null) as T };
      } catch {
        throw new HttpError(`Invalid JSON from ${safeUrl}: ${redact(text.slice(0, 200))}`, res.status, safeUrl, false);
      }
    }
    throw lastErr ?? new HttpError(`Request failed: ${safeUrl}`, null, safeUrl, false);
  }
}

function backoff(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}
