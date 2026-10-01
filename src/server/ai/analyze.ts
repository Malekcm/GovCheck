import type { AppConfig } from '../config';
import type { Db } from '../db';
import { json } from '../db';
import { sha256, stableStringify } from '../lib/hash';
import { htmlToText } from '../lib/text';
import { AnthropicProvider } from './anthropic';
import type { AiProvider, OpportunityExtractionT } from './provider';

export function createAiProvider(config: AppConfig): AiProvider | null {
  return config.anthropicApiKey ? new AnthropicProvider(config.anthropicApiKey, config.anthropicModel) : null;
}

const MAX_DOC_CHARS = 60_000;
const MAX_TOTAL_CHARS = 180_000;

type Item = { text: string; evidence_quote: string | null; document: string | null; page: number | null };

/** Map extraction fields to requirement categories shown in the dossier. */
const LIST_FIELDS: [keyof OpportunityExtractionT, string][] = [
  ['objectives', 'objective'],
  ['tasks', 'task'],
  ['workstreams', 'workstream'],
  ['deliverables', 'deliverable'],
  ['mandatory_requirements', 'mandatory'],
  ['technical_requirements', 'technical'],
  ['labor_categories', 'labor_category'],
  ['key_personnel', 'key_personnel'],
  ['certifications', 'certification'],
  ['performance_standards', 'performance_standard'],
  ['reporting_requirements', 'reporting'],
  ['compliance_requirements', 'compliance'],
  ['page_limits', 'page_limit'],
  ['required_volumes', 'volume'],
  ['forms_and_representations', 'form'],
  ['evaluation_criteria', 'evaluation_factor'],
];
const SINGLE_FIELDS: [keyof OpportunityExtractionT, string][] = [
  ['security_clearance', 'clearance'],
  ['contract_vehicle', 'contract_vehicle'],
  ['contract_type', 'contract_type'],
  ['pricing_information', 'pricing'],
  ['period_of_performance', 'period_of_performance'],
  ['option_periods', 'option_periods'],
  ['place_of_performance', 'location'],
  ['travel', 'travel'],
  ['submission_deadline', 'submission_deadline'],
  ['questions_deadline', 'question_deadline'],
  ['submission_method', 'submission'],
];

export interface AnalyzeOutcome {
  status: 'success' | 'cached' | 'refused' | 'failed' | 'unavailable' | 'no_content';
  analysisId?: string;
  message?: string;
}

/**
 * Run (or reuse) AI extraction for one profile. Results are cached by a hash of the exact
 * input content + model + prompt version, so unchanged content is never re-analyzed.
 */
export async function analyzeOpportunity(db: Db, provider: AiProvider | null, opportunityId: string, opts: { force?: boolean } = {}): Promise<AnalyzeOutcome> {
  if (!provider) return { status: 'unavailable', message: 'AI is not configured (set ANTHROPIC_API_KEY). Everything else works without it.' };
  const o = await db.one<any>('SELECT id, title, description, department_name, subtier_name, notice_type FROM opportunities WHERE id = $1', [opportunityId]);
  if (!o) return { status: 'failed', message: 'Opportunity not found' };
  const docs = await db.query<{ id: string; filename: string | null; url: string; text_content: string | null }>(
    `SELECT id, filename, url, text_content FROM opportunity_documents WHERE opportunity_id = $1 AND text_status IN ('extracted','ocr_needed') AND text_content IS NOT NULL ORDER BY doc_type = 'AMENDMENT', posted_at NULLS LAST`,
    [opportunityId],
  );
  const description = htmlToText(o.description ?? '');
  let budget = MAX_TOTAL_CHARS - description.length;
  const documents: { name: string; text: string }[] = [];
  for (const d of docs) {
    if (budget <= 2000) break;
    const text = (d.text_content ?? '').slice(0, Math.min(MAX_DOC_CHARS, budget));
    budget -= text.length;
    documents.push({ name: d.filename ?? d.url.split('/').pop() ?? 'document', text });
  }
  if (description.length < 80 && !documents.length) return { status: 'no_content', message: 'Not enough text to analyze yet (no description or extracted documents).' };

  const input = { title: o.title, agency: o.subtier_name ?? o.department_name, noticeType: o.notice_type, description, documents };
  const hash = sha256(stableStringify({ input, model: provider.model, prompt: provider.promptVersion }));
  const cached = await db.one<{ id: string; status: string; output: OpportunityExtractionT | null }>(
    'SELECT id, status, output FROM ai_analyses WHERE content_hash = $1 AND analysis_type = $2 AND model = $3 AND prompt_version = $4',
    [hash, 'requirements_extraction', provider.model, provider.promptVersion],
  );
  if (cached && cached.status === 'success' && !opts.force) {
    await applyExtraction(db, opportunityId, cached.id, cached.output!, docs, hash);
    return { status: 'cached', analysisId: cached.id, message: 'Content unchanged since the last analysis — reused cached result (no tokens spent).' };
  }

  const res = await provider.extractOpportunity(input);
  const row = await db.one<{ id: string }>(
    `INSERT INTO ai_analyses (content_hash, analysis_type, provider, model, prompt_version, status, output, error_message, input_tokens, output_tokens, opportunity_id)
     VALUES ($1,'requirements_extraction',$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
     ON CONFLICT (content_hash, analysis_type, model, prompt_version) DO UPDATE SET status = EXCLUDED.status, output = EXCLUDED.output, error_message = EXCLUDED.error_message,
       input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens, created_at = now()
     RETURNING id`,
    [hash, provider.name, provider.model, provider.promptVersion, res.status, json(res.output), res.error ?? null, res.inputTokens ?? null, res.outputTokens ?? null, opportunityId],
  );
  if (res.status !== 'success' || !res.output) return { status: res.status === 'refused' ? 'refused' : 'failed', analysisId: row!.id, message: res.error };
  await applyExtraction(db, opportunityId, row!.id, res.output, docs, hash);
  return { status: 'success', analysisId: row!.id };
}

async function applyExtraction(db: Db, opportunityId: string, analysisId: string, out: OpportunityExtractionT, docs: { id: string; filename: string | null; url: string }[], hash: string): Promise<void> {
  const docId = (name: string | null) => (name ? docs.find((d) => (d.filename ?? d.url.split('/').pop()) === name)?.id ?? null : null);
  const rows: Record<string, unknown>[] = [];
  const push = (category: string, it: Item | null) => {
    if (!it || !it.text?.trim()) return;
    rows.push({ category, text: it.text.slice(0, 1000), document_id: docId(it.document), page: it.page, quote: it.evidence_quote?.slice(0, 600) ?? null });
  };
  for (const [field, cat] of LIST_FIELDS) for (const it of (out[field] as Item[]) ?? []) push(cat, it);
  for (const [field, cat] of SINGLE_FIELDS) push(cat, out[field] as Item | null);
  for (const t of out.technologies ?? []) push('technology', { text: t, evidence_quote: null, document: null, page: null });
  for (const t of out.systems ?? []) push('system', { text: t, evidence_quote: null, document: null, page: null });
  for (const r of out.risks ?? []) push('risk', { text: r, evidence_quote: null, document: null, page: null });
  for (const m of out.missing_information ?? []) push('missing_information', { text: m, evidence_quote: null, document: null, page: null });
  if (out.staffing) push('staffing', { text: out.staffing, evidence_quote: null, document: null, page: null });

  await db.tx(async (tx) => {
    await tx.query(`UPDATE opportunity_requirements SET is_current = false WHERE opportunity_id = $1 AND provenance = 'ai_extracted' AND is_current`, [opportunityId]);
    if (rows.length)
      await tx.query(
        `INSERT INTO opportunity_requirements (opportunity_id, category, text, provenance, document_id, page, evidence_quote, analysis_id, content_hash)
         SELECT $1, x.category, x.text, 'ai_extracted', x.document_id, x.page, x.quote, $2, $3 FROM jsonb_to_recordset($4::jsonb) AS x(category text, text text, document_id uuid, page int, quote text)`,
        [opportunityId, analysisId, hash, json(rows)],
      );
    const summary = [out.work_summary, out.customer_need ? `Customer need: ${out.customer_need}` : null].filter(Boolean).join('\n\n');
    await tx.query('UPDATE opportunities SET summary = $2 WHERE id = $1', [opportunityId, summary || null]);
    await tx.query(
      `INSERT INTO app_state (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [`ai_brief:${opportunityId}`, json({ analysisId, likely_responsibilities: out.likely_responsibilities ?? [], customer_need: out.customer_need, work_summary: out.work_summary })],
    );
  });
}
