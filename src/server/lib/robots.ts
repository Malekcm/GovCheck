import type { HttpClient } from './http';

interface RobotsRules {
  disallow: string[];
  allow: string[];
  crawlDelaySec?: number;
  fetchedAt: number;
}

const cache = new Map<string, RobotsRules>();

function parseRobots(txt: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], fetchedAt: Date.now() };
  let applies = false;
  let sawRuleForGroup = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (sawRuleForGroup) {
        applies = false;
        sawRuleForGroup = false;
      }
      if (value === '*') applies = true;
    } else {
      sawRuleForGroup = true;
      if (!applies) continue;
      if (key === 'disallow' && value) rules.disallow.push(value);
      else if (key === 'allow' && value) rules.allow.push(value);
      else if (key === 'crawl-delay') rules.crawlDelaySec = Number(value) || undefined;
    }
  }
  return rules;
}

function patternMatches(pattern: string, pathAndQuery: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(pathAndQuery);
}

/** Longest-match semantics as used by major crawlers: the most specific rule wins; ties go to Allow. */
export function isAllowedByRules(rules: Pick<RobotsRules, 'allow' | 'disallow'>, pathAndQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  for (const p of rules.disallow) if (patternMatches(p, pathAndQuery) && (!best || p.length > best.len)) best = { len: p.length, allow: false };
  for (const p of rules.allow) if (patternMatches(p, pathAndQuery) && (!best || p.length >= best.len)) best = { len: p.length, allow: true };
  return best ? best.allow : true;
}

/** Check robots.txt for a URL (cached for 6 hours). Fails closed if robots.txt explicitly cannot be parsed? No: a missing robots.txt means allowed. */
export async function robotsAllows(http: HttpClient, url: string): Promise<{ allowed: boolean; crawlDelaySec?: number }> {
  const u = new URL(url);
  const key = u.origin;
  let rules = cache.get(key);
  if (!rules || Date.now() - rules.fetchedAt > 6 * 3600_000) {
    try {
      const res = await http.request<string>({ url: `${u.origin}/robots.txt`, responseType: 'text', retries: 1, timeoutMs: 15_000 });
      rules = parseRobots(res.data);
    } catch {
      rules = { disallow: [], allow: [], fetchedAt: Date.now() };
    }
    cache.set(key, rules);
  }
  return { allowed: isAllowedByRules(rules, u.pathname + u.search), crawlDelaySec: rules.crawlDelaySec };
}

export { parseRobots };
