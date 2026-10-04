import type { AppConfig } from '../config';
import type { Db } from '../db';
import { json } from '../db';
import { extractRuleRequirements } from '../ai/rules';
import { classifyDocument, extractDocumentText, filenameFromDisposition } from '../documents/extract';
import { sha256 } from '../lib/hash';
import type { HttpClient } from '../lib/http';
import type { Logger } from '../lib/logger';
import { errorMessage } from '../lib/logger';
import { robotsAllows } from '../lib/robots';
import { htmlToText } from '../lib/text';
import type { RequestBudget } from '../connectors/types';
import { SAM_BUDGET_KEY } from '../connectors/sam/samOpportunities';
import { recordEvent } from './events';

export interface DocDeps {
  db: Db;
  http: HttpClient;
  config: AppConfig;
  log: Logger;
  budget: RequestBudget;
}

interface DocRow {
  id: string;
  opportunity_id: string;
  url: string;
  filename: string | null;
  mime_type: string | null;
  content_hash: string | null;
  version: number;
  doc_type: string | null;
}

const API_HOSTS = /(^|\.)(api\.sam\.gov|sam\.gov|grants\.gov|api\.grants\.gov)$/i;

/** Download and parse one document. Respects the SAM request budget and robots.txt for non-API hosts. */
export async function processDocument(deps: DocDeps, d: DocRow): Promise<string> {
  const { db } = deps;
  let url = d.url;
  const host = new URL(url).host;
  const isSam = /sam\.gov$/i.test(host);
  if (isSam) {
    if (!deps.config.samDownloadDocuments || !deps.config.samApiKey) {
      await db.query(`UPDATE opportunity_documents SET retrieval_status = 'skipped', error_message = $2 WHERE id = $1`, [
        d.id,
        'SAM.gov attachment downloads count against the daily API request budget. Set SAM_DOWNLOAD_DOCUMENTS=true to enable, or open the file on SAM.gov.',
      ]);
      return 'skipped';
    }
    // Attachments are the lowest SAM priority: never dip into the interactive reserve.
    if ((await deps.budget.remaining(SAM_BUDGET_KEY)) <= Math.max(1, deps.config.samManualReserve)) return 'deferred';
    const u = new URL(url);
    u.searchParams.set('api_key', deps.config.samApiKey);
    url = u.toString();
    await deps.budget.consume(SAM_BUDGET_KEY, 1, { category: 'documents', connectorId: 'engine:documents', detail: { documentId: d.id } });
  } else if (!API_HOSTS.test(host)) {
    const robots = await robotsAllows(deps.http, url);
    if (!robots.allowed) {
      await db.query(`UPDATE opportunity_documents SET retrieval_status = 'skipped', error_message = $2 WHERE id = $1`, [d.id, 'The host’s robots.txt disallows automated downloads of this file. Open it from the source link.']);
      return 'skipped';
    }
  }

  let buf: Buffer;
  let mime: string | null = d.mime_type;
  let filename = d.filename;
  try {
    // Document URLs come from third-party data: refuse private/loopback targets (SSRF guard).
    const res = await deps.http.request<Buffer>({ url, responseType: 'buffer', timeoutMs: 120_000, retries: 2, maxBytes: deps.config.documentMaxBytes, hostDelayMs: 1500, publicOnly: true });
    buf = res.data;
    mime = res.headers.get('content-type') ?? mime;
    filename = filenameFromDisposition(res.headers.get('content-disposition')) ?? filename ?? decodeURIComponent(new URL(d.url).pathname.split('/').pop() ?? '') ?? null;
  } catch (err) {
    const msg = errorMessage(err);
    await db.query(`UPDATE opportunity_documents SET retrieval_status = $2, error_message = $3 WHERE id = $1`, [d.id, /too large/i.test(msg) ? 'too_large' : 'failed', msg]);
    return 'failed';
  }

  const hash = sha256(buf);
  if (d.content_hash === hash) {
    await db.query(`UPDATE opportunity_documents SET retrieval_status = 'downloaded', retrieved_at = now(), last_seen_at = now() WHERE id = $1`, [d.id]);
    return 'unchanged';
  }
  const extracted = await extractDocumentText(buf, filename, mime);
  const changed = !!d.content_hash;
  const docType = d.doc_type ?? classifyDocument(filename, extracted.text);
  await db.query(
    `UPDATE opportunity_documents SET retrieval_status = 'downloaded', text_status = $2, text_content = $3, page_count = $4, content_hash = $5,
       previous_hash = CASE WHEN $6 THEN content_hash ELSE previous_hash END, version = CASE WHEN $6 THEN version + 1 ELSE version END,
       changed_since_previous = $6, filename = COALESCE($7, filename), mime_type = $8, size_bytes = $9, doc_type = $10, error_message = $11, retrieved_at = now()
     WHERE id = $1`,
    [d.id, extracted.status, extracted.text, extracted.pageCount, hash, changed, filename, mime, buf.length, docType, extracted.error ?? null],
  );
  if (changed) await recordEvent(db, d.opportunity_id, { type: 'DOCUMENT_UPDATED', title: `Document updated: ${filename ?? d.url} (version ${d.version + 1})`, dedupeKey: `docv:${d.id}:${hash}`, detail: { documentId: d.id } });
  // Classified concepts a BD lead must notice immediately.
  if (docType === 'QA') await recordEvent(db, d.opportunity_id, { type: 'QA_PUBLISHED', title: `Q&A published: ${filename ?? d.url}`, dedupeKey: `qa:${d.id}:${hash}`, detail: { documentId: d.id }, isLifecycle: true, lifecycleStage: 'qa' });
  if (docType === 'AMENDMENT') await recordEvent(db, d.opportunity_id, { type: 'AMENDMENT', title: `Amendment document: ${filename ?? d.url}`, dedupeKey: `amd-doc:${d.id}:${hash}`, detail: { documentId: d.id }, isLifecycle: true, lifecycleStage: 'amendment' });

  if (extracted.text) await storeRuleRequirements(db, d.opportunity_id, extracted.text, hash, d.id, extracted.pages);
  await db.query('UPDATE opportunities SET has_documents = true WHERE id = $1', [d.opportunity_id]);
  return changed ? 'updated' : 'downloaded';
}

/** Store deterministic (DERIVED) requirements with evidence quotes. Replaces earlier ones from the same source text. */
/** Bump when rules change so unchanged text is re-extracted once with the new rules. */
export const RULES_VERSION = 'r2';

export async function storeRuleRequirements(db: Db, opportunityId: string, text: string, textHash: string, documentId: string | null, pages?: string[]): Promise<number> {
  const contentHash = `${textHash}:${RULES_VERSION}`;
  const reqs = extractRuleRequirements(text);
  await db.query(
    `UPDATE opportunity_requirements SET is_current = false WHERE opportunity_id = $1 AND provenance = 'derived' AND document_id IS NOT DISTINCT FROM $2::uuid AND content_hash IS DISTINCT FROM $3`,
    [opportunityId, documentId, contentHash],
  );
  const exists = await db.one(`SELECT 1 FROM opportunity_requirements WHERE opportunity_id = $1 AND provenance = 'derived' AND document_id IS NOT DISTINCT FROM $2::uuid AND content_hash = $3 LIMIT 1`, [
    opportunityId,
    documentId,
    contentHash,
  ]);
  if (exists || !reqs.length) return 0;
  const pageOf = (quote: string) => {
    if (!pages) return null;
    const probe = quote.replace(/^…|…$/g, '').slice(10, 50);
    const idx = pages.findIndex((p) => p.includes(probe));
    return idx >= 0 ? idx + 1 : null;
  };
  await db.query(
    `INSERT INTO opportunity_requirements (opportunity_id, category, text, provenance, document_id, page, evidence_quote, content_hash, strength)
     SELECT $1, x.category, x.text, 'derived', $2, x.page, x.quote, $3, x.strength FROM jsonb_to_recordset($4::jsonb) AS x(category text, text text, page int, quote text, strength text)`,
    [opportunityId, documentId, contentHash, json(reqs.map((r) => ({ ...r, page: pageOf(r.quote) })))],
  );
  return reqs.length;
}

/** Derived requirements from the opportunity description itself (no download needed). */
export async function extractDescriptionRequirements(db: Db, opportunityId: string): Promise<number> {
  const o = await db.one<{ description: string | null; title: string }>('SELECT title, description FROM opportunities WHERE id = $1', [opportunityId]);
  if (!o?.description) return 0;
  const text = `${o.title}\n${htmlToText(o.description)}`;
  return storeRuleRequirements(db, opportunityId, text, sha256(text), null);
}

export async function processPendingDocuments(deps: DocDeps, opts: { limit: number; opportunityIds?: string[] }): Promise<Record<string, number>> {
  const params: unknown[] = [opts.limit];
  let where = `d.retrieval_status IN ('not_downloaded') `;
  if (opts.opportunityIds?.length) {
    params.push(opts.opportunityIds);
    where = `d.retrieval_status IN ('not_downloaded','failed') AND d.opportunity_id = ANY($2::uuid[])`;
  } else where += `AND COALESCE(o.fit_score, 0) >= 40 AND o.status IN ('active','forecast')`;
  const docs = await deps.db.query<DocRow>(
    `SELECT d.id, d.opportunity_id, d.url, d.filename, d.mime_type, d.content_hash, d.version, d.doc_type FROM opportunity_documents d JOIN opportunities o ON o.id = d.opportunity_id
     WHERE ${where} ORDER BY o.fit_score DESC NULLS LAST, d.first_seen_at DESC LIMIT $1`,
    params,
  );
  const counts: Record<string, number> = {};
  for (const d of docs) {
    try {
      const r = await processDocument(deps, d);
      counts[r] = (counts[r] ?? 0) + 1;
    } catch (err) {
      deps.log.warn(`Document processing failed for ${d.url}`, err);
      counts.failed = (counts.failed ?? 0) + 1;
    }
  }
  return counts;
}
