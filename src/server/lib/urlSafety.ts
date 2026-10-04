import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF protection for URLs that come from configuration or from third-party data
 * (custom feed URLs, document links inside notices). Only public http(s) hosts are
 * allowed: loopback, private, link-local (incl. cloud metadata 169.254.169.254),
 * CGNAT, multicast and reserved ranges are refused, both by literal IP and after DNS
 * resolution. Redirect targets are re-checked by the HTTP client.
 */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd)/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || v.startsWith('2001:db8');
  }
  return true; // not an IP at all: treat as unsafe
}

/** Synchronous checks that need no DNS (scheme, credentials, literal IPs, obvious local names). */
export function assertSafeUrlSyntax(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${raw.slice(0, 120)}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UnsafeUrlError(`Only http(s) URLs are allowed (got ${u.protocol}).`);
  if (u.username || u.password) throw new UnsafeUrlError('URLs with embedded credentials are not allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new UnsafeUrlError(`Host ${host || '(empty)'} is not a public internet host.`);
  if (net.isIP(host) && isPrivateAddress(host)) throw new UnsafeUrlError(`Address ${host} is private, loopback or reserved.`);
  return u;
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

/** Full check including DNS resolution. Throws UnsafeUrlError when the URL must not be fetched. */
export async function assertPublicUrl(raw: string, resolve: Resolver = defaultResolver): Promise<URL> {
  const u = assertSafeUrlSyntax(raw);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return u;
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new UnsafeUrlError(`Host ${host} could not be resolved.`);
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new UnsafeUrlError(`Host ${host} resolves to a private or reserved address.`);
  return u;
}
