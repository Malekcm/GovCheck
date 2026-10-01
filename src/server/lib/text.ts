import sanitize from 'sanitize-html';

/**
 * Sanitize externally sourced HTML (SAM descriptions, grant synopses, SUBNet
 * descriptions) down to a small, safe formatting subset. Links are forced to
 * open in a new tab with noopener; scripts, styles, iframes, event handlers and
 * javascript: URLs are removed.
 */
export function sanitizeExternalHtml(html: string | null | undefined): string {
  if (!html) return '';
  return sanitize(html, {
    allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'blockquote', 'pre', 'code', 'span', 'div', 'hr'],
    allowedAttributes: { a: ['href', 'title'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitize.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }),
    },
    disallowedTagsMode: 'discard',
  }).trim();
}

const ENTITY_MAP: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) => ENTITY_MAP[name.toLowerCase()] ?? m);
}

/** Convert HTML to readable plain text (paragraph breaks preserved). */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][\s\S]*?>/i.test(s);
}

/** Normalize an entity name into a comparison key (agencies, offices, vendors). */
export function nameKey(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[.,'’"()]/g, '')
    .replace(/\b(INC|INCORPORATED|LLC|L L C|CORP|CORPORATION|CO|COMPANY|LTD|LP|LLP|PLLC|PC)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return '';
  if (s !== s.toUpperCase()) return s;
  const small = new Set(['OF', 'AND', 'THE', 'FOR', 'IN', 'ON', 'TO', 'A', 'AN', 'AT', 'BY']);
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => {
      if (i > 0 && small.has(w.toUpperCase())) return w;
      if (/^(us|usa|dod|dhs|va|gsa|nasa|faa|irs|hhs|doe|doj|dot|epa|sba|ii|iii|iv|it|onr|nih|cdc|fda|cms|ssa|opm|usda|dol|dos|nsf|noaa|uscg|usaf|usmc|disa|dla|navsea|navair|navwar|niwc|fema|ice|cbp|tsa|uscis|hud|ed|doc|nist|nps|blm|ihs|hrsa|samhsa|cio|it|ai|ml|bi|qa|pmo|erp|crm|hr|sap|aws|gis|ii|iv|vi|ix|xi|llc|inc)$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

// -------------------------------------------------------------------------
// Tokenization for similarity scoring
// -------------------------------------------------------------------------
const STOPWORDS = new Set(
  (
    'a an and are as at be by for from has have in is it its of on or that the this to was were will with shall must may ' +
    'should can could would not no all any each other such these those their there which who whom what when where how ' +
    'contract contractor contracting government agency services service support provide provides providing requirement ' +
    'requirements notice solicitation opportunity federal office department work performance include including within ' +
    'per also via under upon into over more than only one two three been being both but if then so up out about after ' +
    'before between during through we our you your they them he she his her us use used using based new see attached ' +
    'please information following required necessary related additional general sam gov www http https'
  ).split(/\s+/),
);

export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/[\s/-]+/)
    .map((t) => t.replace(/^[.]+|[.]+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

/** Very light suffix stripping so "dashboards"/"dashboard", "developing"/"develop" match. */
export function stem(t: string): string {
  if (t.length <= 4) return t;
  return t
    .replace(/ies$/, 'y')
    .replace(/(ing|ings)$/, '')
    .replace(/(ment|ments)$/, '')
    .replace(/(ed|es)$/, '')
    .replace(/s$/, '');
}

/** Case-insensitive whole-phrase search. Returns the index or -1. */
export function findPhrase(haystackLower: string, phrase: string): number {
  const p = phrase.toLowerCase().trim();
  if (!p) return -1;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s\\-/]+');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i');
  const m = re.exec(haystackLower);
  return m ? m.index + m[1].length : -1;
}

export function snippetAround(text: string, index: number, length: number, radius = 90): string {
  if (index < 0) return '';
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}
