import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { htmlToText } from '../lib/text';

export interface ExtractedText {
  status: 'extracted' | 'unsupported' | 'ocr_needed' | 'failed';
  text: string | null;
  pageCount: number | null;
  /** Per-page text when available (for page-level evidence). */
  pages?: string[];
  error?: string;
}

const MAX_TEXT = 2_000_000;

export function detectType(filename: string | null, mime: string | null, buf: Buffer): 'pdf' | 'docx' | 'xlsx' | 'csv' | 'txt' | 'html' | 'unknown' {
  const name = (filename ?? '').toLowerCase();
  const m = (mime ?? '').toLowerCase();
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-' || m.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (m.includes('wordprocessingml') || name.endsWith('.docx')) return 'docx';
  if (m.includes('spreadsheetml') || name.endsWith('.xlsx')) return 'xlsx';
  if (m.includes('csv') || name.endsWith('.csv')) return 'csv';
  if (m.includes('html') || name.endsWith('.html') || name.endsWith('.htm')) return 'html';
  if (m.startsWith('text/') || name.endsWith('.txt')) return 'txt';
  // ZIP container sniffing for Office files without names
  if (buf.subarray(0, 2).toString('latin1') === 'PK') {
    const head = buf.subarray(0, 4000).toString('latin1');
    if (head.includes('word/')) return 'docx';
    if (head.includes('xl/')) return 'xlsx';
  }
  return 'unknown';
}

/** Extract text from a public solicitation document. Never throws: failures are reported as a status. */
export async function extractDocumentText(buf: Buffer, filename: string | null, mime: string | null): Promise<ExtractedText> {
  const type = detectType(filename, mime, buf);
  try {
    switch (type) {
      case 'pdf': {
        const pdf = await getDocumentProxy(new Uint8Array(buf));
        const { totalPages, text } = await extractText(pdf, { mergePages: false });
        const pages = text.map((t) => t.replace(/[ \t]+/g, ' ').trim());
        const joined = pages.map((p, i) => `[Page ${i + 1}]\n${p}`).join('\n\n');
        const chars = pages.join('').replace(/\s/g, '').length;
        // Scanned PDFs have pages but almost no text layer. OCR is optional and not run here.
        if (totalPages > 0 && chars / totalPages < 40) return { status: 'ocr_needed', text: joined.slice(0, MAX_TEXT) || null, pageCount: totalPages, pages, error: 'Little or no text layer — likely a scanned document. OCR is not enabled.' };
        return { status: 'extracted', text: joined.slice(0, MAX_TEXT), pageCount: totalPages, pages };
      }
      case 'docx': {
        const { value } = await mammoth.extractRawText({ buffer: buf });
        return { status: 'extracted', text: value.slice(0, MAX_TEXT), pageCount: null };
      }
      case 'xlsx': {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as any);
        const parts: string[] = [];
        wb.eachSheet((ws) => {
          parts.push(`[Sheet ${ws.name}]`);
          ws.eachRow({ includeEmpty: false }, (row) => {
            const vals = (row.values as unknown[]).slice(1).map((v) => (v && typeof v === 'object' && 'text' in (v as any) ? (v as any).text : v ?? '')).map(String);
            if (vals.some((v) => v.trim())) parts.push(vals.join('\t'));
          });
        });
        return { status: 'extracted', text: parts.join('\n').slice(0, MAX_TEXT), pageCount: null };
      }
      case 'csv':
      case 'txt':
        return { status: 'extracted', text: buf.toString('utf8').slice(0, MAX_TEXT), pageCount: null };
      case 'html':
        return { status: 'extracted', text: htmlToText(buf.toString('utf8')).slice(0, MAX_TEXT), pageCount: null };
      default:
        return { status: 'unsupported', text: null, pageCount: null, error: `Unsupported document type (${mime ?? filename ?? 'unknown'})` };
    }
  } catch (err) {
    return { status: 'failed', text: null, pageCount: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/**
 * Solicitation document concepts. The filename is the strongest signal (agencies name files
 * "Attachment 3 - PWS.pdf", "Section L.docx"); the opening text is used only with stricter
 * patterns, because phrases like "acknowledge all amendments" appear inside almost every RFP.
 */
const BY_NAME: [RegExp, string][] = [
  [/amendment|\bamd\b|\bmod(ification)?\b|sf[\s_-]?30\b/, 'AMENDMENT'],
  [/\bq\s*&\s*a\b|q\s*and\s*a|questions?[\s_-]+(and|&)[\s_-]+answers?|responses?[\s_-]+to[\s_-]+questions/, 'QA'],
  [/section[\s_-]*l\b|instructions[\s_-]+to[\s_-]+offerors|proposal[\s_-]+instructions/, 'SECTION_L'],
  [/section[\s_-]*m\b|evaluation[\s_-]+(criteria|factors)|basis[\s_-]+(of|for)[\s_-]+award/, 'SECTION_M'],
  [/performance[\s_-]+work[\s_-]+statement|\bpws\b/, 'PWS'],
  [/statement[\s_-]+of[\s_-]+objectives|\bsoo\b/, 'SOO'],
  [/statement[\s_-]+of[\s_-]+work|\bsow\b/, 'SOW'],
  [/\bclins?\b|price|pricing|cost[\s_-]+(sheet|schedule|model)|schedule[\s_-]+b\b|\bbid[\s_-]+schedule/, 'PRICING'],
  [/past[\s_-]+performance[\s_-]+(questionnaire|survey)|\bppq\b|\bppirs?\b/, 'PAST_PERFORMANCE'],
  [/dd[\s_-]*(form[\s_-]*)?254|security[\s_-]+(requirements|classification)/, 'SECURITY'],
  [/wage[\s_-]+determination|\bwd[\s_-]?\d{4}|service[\s_-]+contract[\s_-]+act/, 'WAGE_DETERMINATION'],
  [/sources[\s_-]+sought/, 'SOURCES_SOUGHT'],
  [/\brfi\b|request[\s_-]+for[\s_-]+information/, 'RFI'],
  [/\brfq\b|request[\s_-]+for[\s_-]+quot/, 'RFQ'],
  [/\brfp\b|request[\s_-]+for[\s_-]+proposal|sf[\s_-]?1449|sf[\s_-]?33\b|solicitation/, 'RFP'],
  [/nofo|notice[\s_-]+of[\s_-]+funding|funding[\s_-]+opportunity[\s_-]+announcement|full[\s_-]+announcement/, 'ANNOUNCEMENT'],
  [/\bsf[\s_-]?\d{2,4}\b|\bform\b/, 'FORM'],
];

const BY_TEXT: [RegExp, string][] = [
  [/^\s*(amendment\s+of\s+solicitation|amendment\s+(no\.?|number)\s*\d+)|standard\s+form\s+30\b/m, 'AMENDMENT'],
  [/questions\s+and\s+answers|responses\s+to\s+(industry|vendor|offeror)?\s*questions/, 'QA'],
  [/instructions,?\s+conditions,?\s+and\s+notices\s+to\s+offerors/, 'SECTION_L'],
  [/evaluation\s+factors\s+for\s+award/, 'SECTION_M'],
  [/performance\s+work\s+statement/, 'PWS'],
  [/statement\s+of\s+objectives/, 'SOO'],
  [/statement\s+of\s+work/, 'SOW'],
  [/past\s+performance\s+(questionnaire|survey)/, 'PAST_PERFORMANCE'],
  [/contract\s+security\s+classification\s+specification/, 'SECURITY'],
  [/wage\s+determination\s+no/, 'WAGE_DETERMINATION'],
  [/sources\s+sought/, 'SOURCES_SOUGHT'],
  [/request\s+for\s+information/, 'RFI'],
  [/request\s+for\s+quot/, 'RFQ'],
  [/request\s+for\s+proposals?|solicitation\/contract\/order\s+for\s+commercial/, 'RFP'],
  [/notice\s+of\s+funding\s+opportunity|funding\s+opportunity\s+announcement/, 'ANNOUNCEMENT'],
];

export function classifyDocument(filename: string | null, text: string | null): string {
  // Underscores are word characters for \b, so treat them (and dots) as separators.
  const name = (filename ?? '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .replace(/[_.]+/g, ' ');
  for (const [re, type] of BY_NAME) if (name && re.test(name)) return type;
  const head = (text ?? '').slice(0, 2500).toLowerCase();
  for (const [re, type] of BY_TEXT) if (head && re.test(head)) return type;
  return 'ATTACHMENT';
}
