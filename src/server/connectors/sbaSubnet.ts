import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import { stableStringify } from '../lib/hash';
import { toIso } from '../lib/dates';
import { robotsAllows } from '../lib/robots';
import { decodeEntities, htmlToText, sanitizeExternalHtml } from '../lib/text';
import type { ConnectorContext, FetchPage, NormalizedOpportunity, RawRecord, SourceAdapter } from './types';
import { stateCode } from './util';

export const SUBNET_ORIGIN = 'https://legacy.sba.gov';
export const SUBNET_LIST_PATH = '/federal-contracting/contracting-guide/prime-subcontracting/subcontracting-opportunities';

export interface SubnetListingRow {
  path: string;
  title: string;
  businessName: string | null;
  summary: string | null;
  closingDate: string | null;
  startDate: string | null;
  placeOfPerformance: string | null;
  naics: string | null;
  pointOfContact: string | null;
}

const clean = (s: string | undefined | null) => {
  const t = decodeEntities((s ?? '').replace(/\s+/g, ' ')).trim();
  return t || null;
};

export function parseSubnetListing(html: string): { rows: SubnetListingRow[]; hasNext: boolean } {
  const root = parseHtml(html);
  const rows: SubnetListingRow[] = [];
  for (const tr of root.querySelectorAll('table.usa-table tbody tr')) {
    const cell = (cls: string) => tr.querySelector(`td.views-field-${cls}`);
    const body = tr.querySelector('td.views-field-body');
    const link = body?.querySelector('.subnet_title a');
    const href = link?.getAttribute('href');
    if (!body || !link || !href) continue;
    const summary = body.querySelector('p')?.text ?? null;
    rows.push({
      path: href.startsWith('http') ? new URL(href).pathname : href,
      title: clean(link.text) ?? 'Untitled subcontracting opportunity',
      businessName: clean(body.querySelector('.subnet_business_name')?.text),
      summary: clean(summary),
      closingDate: clean(cell('field-subnet-closing-timestamp')?.text),
      startDate: clean(cell('field-subnet-start-date')?.text),
      placeOfPerformance: clean(cell('field-subnet-place-performance')?.text),
      naics: clean(cell('field-subnet-naics')?.text),
      pointOfContact: clean(cell('nothing')?.text),
    });
  }
  const hasNext = !!root.querySelector('.usa-pagination__next-page, a[rel="next"]') || /page=\d+/.test(root.querySelector('.usa-pagination__list')?.toString() ?? '');
  return { rows, hasNext };
}

function labeled(root: HTMLElement, cls: string): string | null {
  const el = root.querySelector(`.${cls}`);
  if (!el) return null;
  const strong = el.querySelector('strong');
  const raw = el.text.replace(strong?.text ?? '', '');
  return clean(raw);
}

export interface SubnetDetail {
  businessName: string | null;
  division: string | null;
  website: string | null;
  identifier: string | null;
  placeOfPerformance: string | null;
  startDate: string | null;
  closingDate: string | null;
  descriptionHtml: string | null;
  businessTypes: string[];
  naics: { code: string; label: string | null }[];
  contacts: { name: string | null; email: string | null; phone: string | null }[];
  attachments: { url: string; filename: string; size: string | null }[];
}

export function parseSubnetDetail(html: string): SubnetDetail {
  const root = parseHtml(html);
  const main = root.querySelector('main') ?? root;
  const website = main.querySelector('.sba-subnet__website a')?.getAttribute('href') ?? null;
  const descEl = main.querySelector('.sba-subnet__section__desc .field__item') ?? main.querySelector('.sba-subnet__section__desc');
  const businessTypes = main.querySelectorAll('.sba-subnet__section__business-type li').map((li) => clean(li.text)).filter(Boolean) as string[];
  const naics = main.querySelectorAll('.sba-subnet__section__naics li').map((li) => ({
    code: clean(li.querySelector('.code')?.text) ?? '',
    label: clean(li.querySelector('.label')?.text),
  })).filter((n) => /^\d{2,6}$/.test(n.code));
  const contactSection = main.querySelector('.sba-subnet__section__contact');
  const contacts: SubnetDetail['contacts'] = [];
  if (contactSection) {
    const name = labeled(contactSection, 'sba-subnet__poc');
    const emailEl = contactSection.querySelector('a[href^="mailto:"]');
    const email = emailEl ? emailEl.getAttribute('href')!.replace(/^mailto:/i, '').trim() : null;
    const phoneMatch = /(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/.exec(contactSection.text);
    if (name || email || phoneMatch) contacts.push({ name, email, phone: phoneMatch ? phoneMatch[1].trim() : null });
  }
  const attachments = main.querySelectorAll('.sba-subnet__attachments a').map((a) => {
    const href = a.getAttribute('href') ?? '';
    const sizeEl = a.parentNode?.parentNode?.querySelectorAll('span').find((s) => /\d+(\.\d+)?\s*(KB|MB|GB)/i.test(s.text));
    return { url: href.startsWith('http') ? href : `${SUBNET_ORIGIN}${href}`, filename: clean(a.text) ?? 'attachment', size: sizeEl ? clean(sizeEl.text)?.replace(/[()]/g, '') ?? null : null };
  });
  return {
    businessName: labeled(main, 'sba-subnet__business-name'),
    division: labeled(main, 'sba-subnet__division'),
    website,
    identifier: labeled(main, 'sba-subnet__sol-number'),
    placeOfPerformance: labeled(main, 'sba-subnet__place-performance'),
    startDate: labeled(main, 'sba-subnet__start-date'),
    closingDate: labeled(main, 'sba-subnet__closing-date'),
    descriptionHtml: descEl ? sanitizeExternalHtml(descEl.innerHTML) : null,
    businessTypes,
    naics,
    contacts,
    attachments,
  };
}

/** Keep only the <main> region of a detail page as the stored snapshot (navigation chrome changes often). */
export function extractMain(html: string): string {
  const m = /<main[\s\S]*?<\/main>/i.exec(html);
  return (m ? m[0] : html).replace(/<script[\s\S]*?<\/script>/gi, '');
}

async function getText(ctx: ConnectorContext, url: string): Promise<string> {
  const robots = await robotsAllows(ctx.http, url);
  if (!robots.allowed) throw new Error(`robots.txt disallows ${url}; skipping.`);
  const delay = Math.max(Number(ctx.settings.requestDelayMs ?? 2000), (robots.crawlDelaySec ?? 0) * 1000);
  const res = await ctx.http.request<string>({ url, responseType: 'text', timeoutMs: 45_000, retries: 2, hostDelayMs: delay });
  return res.data;
}

export const subnetRecordId = (path: string) => path.replace(/^\/opportunity\//, '').replace(/\/+$/, '');

export const sbaSubnetAdapter: SourceAdapter = {
  meta: {
    id: 'sba_subnet',
    name: 'SBA SUBNet (subcontracting)',
    sourceType: 'subcontract',
    baseUrl: `${SUBNET_ORIGIN}${SUBNET_LIST_PATH}`,
    accessMethod: 'scraper',
    authRequired: false,
    priority: 45,
    defaultScheduleMinutes: 24 * 60,
    description: 'Subcontracting opportunities posted by large prime contractors on SBA SUBNet. Treated as SUBCONTRACT class — you would contract with the prime, not the government.',
    supportsReconcile: false,
    supportsIdentifierFetch: ['subnet_id'],
    notes:
      'SBA publishes no API or feed for SUBNet, so this is a permitted public-page reader: it checks robots.txt, waits ≥2s between requests, and only fetches a detail page when the listing row changed. ' +
      'If SBA changes the page layout the connector reports Degraded instead of failing other syncs.',
  },
  parserVersion: 'subnet-1',

  isConfigured() {
    return { configured: true };
  },

  async testConnection(ctx) {
    try {
      const html = await getText(ctx, `${SUBNET_ORIGIN}${SUBNET_LIST_PATH}?state=All`);
      const { rows } = parseSubnetListing(html);
      return rows.length ? { status: 'healthy', message: `Listing reachable (${rows.length} rows on page 1).` } : { status: 'degraded', message: 'Listing page loaded but no rows parsed — layout may have changed.' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },

  async *fetchIncremental(ctx, cursor): AsyncGenerator<FetchPage> {
    const maxPages = Number(ctx.settings.maxPages ?? 25);
    let parsedAny = false;
    for (let page = 0; page < maxPages; page++) {
      if (ctx.shouldStop()) return;
      const html = await getText(ctx, `${SUBNET_ORIGIN}${SUBNET_LIST_PATH}?state=All&page=${page}`);
      const { rows } = parseSubnetListing(html);
      if (!rows.length) {
        if (page === 0) throw new Error('No SUBNet rows could be parsed from the listing page — the page layout may have changed.');
        break;
      }
      parsedAny = true;
      const records: RawRecord[] = [];
      let requests = 1;
      for (const row of rows) {
        if (ctx.shouldStop()) break;
        const id = subnetRecordId(row.path);
        const existing = await ctx.db.one<{ raw: unknown; raw_text: string | null }>('SELECT raw, raw_text FROM source_records WHERE connector_id = $1 AND source_record_id = $2', ['sba_subnet', id]);
        const unchanged = existing && stableStringify(existing.raw) === stableStringify(row) && existing.raw_text;
        let detailHtml: string | undefined;
        if (!unchanged) {
          try {
            detailHtml = extractMain(await getText(ctx, `${SUBNET_ORIGIN}${row.path}`));
            requests++;
          } catch (err) {
            ctx.log.warn(`SUBNet detail fetch failed for ${row.path}`, err);
          }
        }
        records.push({ sourceRecordId: id, kind: 'subcontract', raw: row, rawText: detailHtml, retrievedAt: new Date(), sourceUrl: `${SUBNET_ORIGIN}${row.path}` });
      }
      yield { records, apiRequests: requests, note: `Listing page ${page + 1}: ${rows.length} rows` };
    }
    yield { records: [], cursor: { ...cursor, lastListingScanAt: new Date().toISOString(), parsedAny } };
  },

  async fetchByIdentifier(ctx, _idType, value) {
    const path = value.startsWith('/') ? value : `/opportunity/${value}`;
    const detailHtml = extractMain(await getText(ctx, `${SUBNET_ORIGIN}${path}`));
    const existing = await ctx.db.one<{ raw: SubnetListingRow }>('SELECT raw FROM source_records WHERE connector_id = $1 AND source_record_id = $2', ['sba_subnet', subnetRecordId(path)]);
    const d = parseSubnetDetail(detailHtml);
    const raw: SubnetListingRow = existing?.raw ?? {
      path,
      title: d.identifier ?? subnetRecordId(path),
      businessName: d.businessName,
      summary: null,
      closingDate: d.closingDate,
      startDate: d.startDate,
      placeOfPerformance: d.placeOfPerformance,
      naics: d.naics[0] ? `${d.naics[0].code}: ${d.naics[0].label ?? ''}` : null,
      pointOfContact: null,
    };
    return [{ sourceRecordId: subnetRecordId(path), kind: 'subcontract', raw, rawText: detailHtml, retrievedAt: new Date(), sourceUrl: `${SUBNET_ORIGIN}${path}` }];
  },

  normalize(record) {
    const row = record.raw as SubnetListingRow;
    const d = record.rawText ? parseSubnetDetail(record.rawText) : null;
    const closing = d?.closingDate ?? row.closingDate;
    const start = d?.startDate ?? row.startDate;
    const closingDate = toIso(closing);
    const naics = d?.naics.length ? d.naics.map((n) => n.code) : row.naics ? [(/^(\d{2,6})/.exec(row.naics) ?? [])[1]].filter(Boolean) : [];
    const placeText = d?.placeOfPerformance ?? row.placeOfPerformance;
    const prime = d?.businessName ?? row.businessName;
    const title = row.title;
    const isRfi = /\b(RFI|request for information)\b/i.test(title);
    const status = closingDate && new Date(closingDate).getTime() < Date.now() ? 'closed' : 'active';
    const data: NormalizedOpportunity = {
      opportunityClass: 'subcontract',
      stage: 'subcontract',
      stageBasis: isRfi ? 'Subcontract RFI posted by the prime contractor.' : undefined,
      noticeType: 'SUBNet subcontracting opportunity',
      status,
      title,
      description: d?.descriptionHtml ?? row.summary,
      identifiers: [{ type: 'subnet_id', value: subnetRecordId(row.path) }],
      agency: {},
      naics: naics as string[],
      dates: [
        ...(closingDate ? [{ kind: 'response_due', value: closingDate }] : []),
        ...(start ? [{ kind: 'performance_start', value: toIso(start) }] : []),
      ],
      financials: [],
      place: placeText ? { state: stateCode(placeText), city: null, country: stateCode(placeText) ? 'USA' : null } : null,
      contacts: (d?.contacts ?? []).map((c) => ({ role: 'prime_contact', fullName: c.name, email: c.email, phone: c.phone, organization: prime })),
      documents: (d?.attachments ?? []).map((a) => ({ url: a.url, filename: a.filename, docType: /rfi/i.test(a.filename) ? 'RFI' : null })),
      links: [{ url: `${SUBNET_ORIGIN}${row.path}`, label: 'SBA SUBNet listing' }, ...(d?.website ? [{ url: d.website, label: 'Prime contractor procurement site' }] : [])],
      url: `${SUBNET_ORIGIN}${row.path}`,
      primeContractor: prime ? { name: prime, website: d?.website ?? null, division: d?.division ?? null } : null,
      eligibility: d?.businessTypes ?? [],
      extra: { placeOfPerformanceText: placeText, solicitedBusinessTypes: d?.businessTypes ?? [], primeIdentifier: d?.identifier, detailCaptured: !!d, summaryText: row.summary ? htmlToText(row.summary) : null },
    };
    return { type: 'opportunity', data };
  },
};
