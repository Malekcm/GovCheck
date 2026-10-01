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

export function classifyDocument(filename: string | null, text: string | null): string {
  const s = `${filename ?? ''} ${(text ?? '').slice(0, 3000)}`.toLowerCase();
  if (/amendment|\bamd\b|sf[\s-]?30/.test(s)) return 'AMENDMENT';
  if (/\bq\s*&\s*a\b|questions and answers|responses to questions/.test(s)) return 'QA';
  if (/performance work statement|\bpws\b/.test(s)) return 'PWS';
  if (/statement of objectives|\bsoo\b/.test(s)) return 'SOO';
  if (/statement of work|\bsow\b/.test(s)) return 'SOW';
  if (/price|pricing|cost\s+sheet|clin/.test(filename?.toLowerCase() ?? '')) return 'PRICING';
  if (/past performance (questionnaire|survey)/.test(s)) return 'PAST_PERFORMANCE';
  if (/sources sought/.test(s)) return 'SOURCES_SOUGHT';
  if (/request for information|\brfi\b/.test(s)) return 'RFI';
  if (/request for quot/.test(s) || /\brfq\b/.test(s)) return 'RFQ';
  if (/request for proposal|\brfp\b|sf[\s-]?1449|sf[\s-]?33/.test(s)) return 'RFP';
  if (/notice of funding|nofo|funding opportunity announcement|full announcement/.test(s)) return 'ANNOUNCEMENT';
  if (/\bsf[\s-]?\d{2,4}\b|form\b/.test(filename?.toLowerCase() ?? '')) return 'FORM';
  return 'ATTACHMENT';
}
