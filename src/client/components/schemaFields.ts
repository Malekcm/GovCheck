/**
 * Pure helpers that turn a G2X tool's JSON input schema into form fields, and form values back
 * into the exact arguments object the tool expects. Kept free of React so they can be unit-tested.
 */
export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  const?: unknown;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  default?: unknown;
  examples?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
};

export type FieldKind = 'naics' | 'agency' | 'set_aside' | 'enum' | 'multi_enum' | 'boolean' | 'number' | 'integer' | 'date' | 'string_list' | 'text' | 'object' | 'json';

export interface Field {
  name: string;
  label: string;
  help: string | null;
  required: boolean;
  kind: FieldKind;
  /** True when the tool takes a list (several codes, agencies or choices). */
  multiple: boolean;
  /** Element type of a list, or the value type of a single field. */
  valueType: 'string' | 'integer' | 'number';
  options: { value: unknown; label: string }[];
  /** date fields: emit a full timestamp instead of YYYY-MM-DD. */
  dateTime: boolean;
  schema: JsonSchema;
  min?: number;
  max?: number;
  maxItems?: number;
  placeholder: string | null;
}

/** Properties GovCheck fills in itself and never shows (paging is always an explicit user action). */
const HIDDEN = /^(cursor|next_cursor|page_token|pagetoken|after_cursor)$/i;

export function resolve(schema: JsonSchema | undefined, root: JsonSchema): JsonSchema {
  if (!schema) return {};
  let s = schema;
  for (let i = 0; i < 5 && s.$ref; i++) {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(s.$ref);
    const target = m ? (root[m[1] as '$defs' | 'definitions'] ?? {})[decodeURIComponent(m[2])] : undefined;
    if (!target) break;
    const { $ref: _ref, ...rest } = s;
    s = { ...target, ...rest };
  }
  if (s.allOf?.length === 1) {
    const { allOf, ...rest } = s;
    s = { ...resolve(allOf[0], root), ...rest };
  }
  // `anyOf: [X, {type: 'null'}]` (optional fields from Pydantic / FastMCP servers) → X
  const alts = s.anyOf ?? s.oneOf;
  if (alts && !alts.every((a) => 'const' in a)) {
    const nonNull = alts.filter((a) => a.type !== 'null');
    if (nonNull.length === 1) {
      const { anyOf: _a, oneOf: _o, ...rest } = s;
      s = { ...resolve(nonNull[0], root), ...rest };
    }
  }
  return s;
}

const types = (s: JsonSchema) => (s.type ? (Array.isArray(s.type) ? s.type : [s.type]) : []).filter((t) => t !== 'null');

export function enumOptions(s: JsonSchema): { value: unknown; label: string }[] | null {
  if (s.enum?.length) return s.enum.filter((v) => v !== null).map((v) => ({ value: v, label: humanize(String(v)) }));
  const alts = s.oneOf ?? s.anyOf;
  if (alts?.length && alts.every((a) => 'const' in a || a.type === 'null')) {
    return alts.filter((a) => 'const' in a && a.const !== null).map((a) => ({ value: a.const, label: a.title ?? humanize(String(a.const)) }));
  }
  return null;
}

const ACRONYMS: Record<string, string> = { naics: 'NAICS', psc: 'PSC', uei: 'UEI', id: 'ID', ids: 'IDs', url: 'URL', sam: 'SAM', gsa: 'GSA', dod: 'DoD', idiq: 'IDIQ', rfp: 'RFP', rfi: 'RFI', rfq: 'RFQ', cage: 'CAGE', piid: 'PIID', sb: 'SB' };

/** "naics_codes" / "naicsCodes" / "Naics Codes" → "NAICS codes" */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return name;
  return words.map((w, i) => ACRONYMS[w.toLowerCase()] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ');
}

const DATE_NAME = /(^|_)(date|deadline|from|to|after|before|since|until|start|end)(_|$)|Date$|(posted|due|response|updated|modified)_?(on|at|by)?$/i;

export function fieldKind(name: string, s: JsonSchema): { kind: FieldKind; multiple: boolean; valueType: Field['valueType'] } {
  const t = types(s);
  const isArray = t.includes('array') || (!t.length && !!s.items);
  const item = isArray ? (s.items ?? {}) : s;
  const it = types(item);
  const valueType: Field['valueType'] = it.includes('integer') ? 'integer' : it.includes('number') ? 'number' : 'string';
  const scalarish = !it.length || it.some((x) => ['string', 'integer', 'number'].includes(x));
  if (enumOptions(item)) return { kind: isArray ? 'multi_enum' : 'enum', multiple: isArray, valueType };
  if (/naics/i.test(name) && scalarish) return { kind: 'naics', multiple: isArray, valueType };
  if (/agenc|department|buyer/i.test(name) && scalarish && valueType === 'string') return { kind: 'agency', multiple: isArray, valueType };
  if (/set.?aside/i.test(name) && scalarish && valueType === 'string') return { kind: 'set_aside', multiple: isArray, valueType };
  if (isArray) return it.every((x) => ['string', 'integer', 'number'].includes(x)) ? { kind: 'string_list', multiple: true, valueType } : { kind: 'json', multiple: true, valueType };
  if (t.includes('boolean')) return { kind: 'boolean', multiple: false, valueType };
  if (t.includes('integer')) return { kind: 'integer', multiple: false, valueType: 'integer' };
  if (t.includes('number')) return { kind: 'number', multiple: false, valueType: 'number' };
  if (t.includes('object') || s.properties) return { kind: s.properties ? 'object' : 'json', multiple: false, valueType };
  if (s.format === 'date' || s.format === 'date-time' || (t.includes('string') && DATE_NAME.test(name))) return { kind: 'date', multiple: false, valueType };
  return { kind: t.length && !t.includes('string') ? 'json' : 'text', multiple: false, valueType };
}

export function fieldsOf(schema: JsonSchema | undefined): Field[] {
  const root = schema ?? {};
  const top = resolve(root, root);
  const required = new Set(top.required ?? []);
  return Object.entries(top.properties ?? {})
    .filter(([name]) => !HIDDEN.test(name))
    .map(([name, raw]) => {
      const s = resolve(raw, root);
      const resolvedItems = s.items ? resolve(s.items, root) : undefined;
      const full = resolvedItems ? { ...s, items: resolvedItems } : s;
      const { kind, multiple, valueType } = fieldKind(name, full);
      const auto = s.title && s.title.toLowerCase().replace(/\s+/g, '') === name.toLowerCase().replace(/[_\s-]+/g, '');
      const example = s.examples?.[0] ?? (s.default !== undefined && s.default !== null ? s.default : undefined);
      return {
        name,
        label: s.title && !auto ? s.title : humanize(name),
        help: s.description ?? null,
        required: required.has(name),
        kind,
        multiple,
        valueType,
        options: enumOptions(resolvedItems ?? full) ?? [],
        dateTime: s.format === 'date-time',
        schema: full,
        min: s.minimum,
        max: s.maximum,
        maxItems: s.maxItems,
        placeholder: example !== undefined ? `e.g. ${Array.isArray(example) ? example.join(', ') : String(example)}` : null,
      } satisfies Field;
    })
    .sort((a, b) => Number(b.required) - Number(a.required));
}

/** Converts one typed value to the element type the schema wants (NAICS 541511 vs "541511"). */
export function coerce(v: unknown, valueType: Field['valueType']): unknown {
  if (valueType === 'string') return typeof v === 'string' ? v : String(v);
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return valueType === 'integer' ? Math.trunc(n) : n;
}

/** Date input value (YYYY-MM-DD) → what the tool takes. */
export function dateValue(d: string, dateTime: boolean) {
  return dateTime ? `${d}T00:00:00Z` : d;
}

/** Drops empty values so the tool only receives what the user actually chose. */
export function cleanArguments(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? v : undefined;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const c = cleanArguments(x);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (v === '' || v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return undefined;
  return v;
}

export function missingRequired(fields: Field[], value: Record<string, unknown>): string[] {
  return fields.filter((f) => f.required && cleanArguments(value[f.name]) === undefined && f.kind !== 'boolean').map((f) => f.label);
}

export const NAICS_CODE = /^\d{2,6}$/;
