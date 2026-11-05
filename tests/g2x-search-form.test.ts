import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { validateAgainstSchema } from '../src/server/team/g2xDiscovery';
import { cleanArguments, coerce, dateValue, fieldsOf, humanize, missingRequired, type JsonSchema } from '../src/client/components/schemaFields';
import { createTestDb, setupCompany, testDeps } from './helpers/setup';

// Synthetic schemas in the two styles MCP servers commonly publish: plain JSON Schema, and the
// Pydantic / FastMCP style with `anyOf: [X, null]`, `$defs` enums and auto titles.
const PLAIN: JsonSchema = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', description: 'Keywords' },
    naics_codes: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    agency: { type: 'string' },
    status: { type: 'string', enum: ['open', 'closed', 'all'] },
    notice_types: { type: 'array', items: { type: 'string', enum: ['solicitation', 'presolicitation', 'sources_sought'] } },
    posted_after: { type: 'string', format: 'date' },
    updated_since: { type: 'string', format: 'date-time' },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    include_awarded: { type: 'boolean' },
    set_aside: { type: 'string' },
    cursor: { type: 'string' },
  },
  additionalProperties: false,
};

const PYDANTIC: JsonSchema = {
  type: 'object',
  $defs: { Category: { type: 'string', enum: ['it_services', 'construction'], title: 'Category' } },
  properties: {
    naics: { anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }], default: null, title: 'Naics' },
    category: { anyOf: [{ $ref: '#/$defs/Category' }, { type: 'null' }], default: null },
    response_due_before: { anyOf: [{ type: 'string' }, { type: 'null' }], title: 'Response Due Before' },
    sort: { oneOf: [{ const: 'relevance', title: 'Most relevant' }, { const: 'newest', title: 'Newest first' }] },
  },
};

describe('G2X search form: fields generated from the tool schema', () => {
  it('turns each schema property into the right kind of field', () => {
    const f = Object.fromEntries(fieldsOf(PLAIN).map((x) => [x.name, x]));
    expect(f.query).toMatchObject({ kind: 'text', required: true, label: 'Query', help: 'Keywords' });
    expect(f.naics_codes).toMatchObject({ kind: 'naics', multiple: true, valueType: 'string', maxItems: 5, label: 'NAICS codes' });
    expect(f.agency).toMatchObject({ kind: 'agency', multiple: false });
    expect(f.status.kind).toBe('enum');
    expect(f.status.options.map((o) => o.value)).toEqual(['open', 'closed', 'all']);
    expect(f.notice_types).toMatchObject({ kind: 'multi_enum', multiple: true });
    expect(f.posted_after).toMatchObject({ kind: 'date', dateTime: false });
    expect(f.updated_since).toMatchObject({ kind: 'date', dateTime: true });
    expect(f.limit).toMatchObject({ kind: 'integer', min: 1, max: 50 });
    expect(f.include_awarded.kind).toBe('boolean');
    expect(f.set_aside.kind).toBe('set_aside');
    // Paging stays an explicit "Load next page" action, never a form field.
    expect(f.cursor).toBeUndefined();
    // Required fields come first.
    expect(fieldsOf(PLAIN)[0].name).toBe('query');
  });

  it('understands Pydantic-style optional fields, $defs enums and const choices', () => {
    const f = Object.fromEntries(fieldsOf(PYDANTIC).map((x) => [x.name, x]));
    expect(f.naics).toMatchObject({ kind: 'naics', multiple: true, valueType: 'integer', label: 'NAICS' });
    expect(f.category.kind).toBe('enum');
    expect(f.category.options.map((o) => o.value)).toEqual(['it_services', 'construction']);
    expect(f.category.options[0].label).toBe('It services');
    expect(f.response_due_before.kind).toBe('date');
    expect(f.sort.options).toEqual([
      { value: 'relevance', label: 'Most relevant' },
      { value: 'newest', label: 'Newest first' },
    ]);
  });

  it('produces arguments that pass the server-side schema check', () => {
    const form = {
      query: 'program management',
      naics_codes: ['541611', '541512'],
      agency: '',
      status: 'open',
      notice_types: [],
      posted_after: dateValue('2026-10-01', false),
      updated_since: dateValue('2026-10-01', true),
      limit: coerce('25', 'integer'),
      include_awarded: false,
    };
    const args = cleanArguments(form) as Record<string, unknown>;
    expect(args).toEqual({
      query: 'program management',
      naics_codes: ['541611', '541512'],
      status: 'open',
      posted_after: '2026-10-01',
      updated_since: '2026-10-01T00:00:00Z',
      limit: 25,
      include_awarded: false,
    });
    expect(validateAgainstSchema(PLAIN as any, args)).toEqual([]);
    // Integer NAICS lists get numbers, not strings.
    expect(['541511', '5415'].map((v) => coerce(v, 'integer'))).toEqual([541511, 5415]);
  });

  it('reports missing required fields by their label', () => {
    expect(missingRequired(fieldsOf(PLAIN), {})).toEqual(['Query']);
    expect(missingRequired(fieldsOf(PLAIN), { query: 'x' })).toEqual([]);
  });

  it('labels fields in plain language', () => {
    expect(humanize('naicsCodes')).toBe('NAICS codes');
    expect(humanize('set_aside_type')).toBe('Set aside type');
    expect(humanize('agency_ids')).toBe('Agency IDs');
  });
});

describe('Lookup lists for the NAICS and agency pickers', () => {
  it('suggests NAICS codes by code prefix or by words, with profile codes first', async () => {
    const db = await createTestDb();
    await setupCompany(db, { naics: ['541511', '236220'] });
    await db.query(`UPDATE company_naics SET description = 'Custom Computer Programming Services' WHERE code = '541511'`);
    await db.query(`INSERT INTO source_records (connector_id, source_record_id, record_kind, raw, content_hash, parser_version, retrieved_at)
      VALUES ('usaspending', 'award-1', 'award', $1::jsonb, 'h1', 'test', now())`, [JSON.stringify({ search: { NAICS: { code: '541611', description: 'ADMINISTRATIVE MANAGEMENT AND GENERAL MANAGEMENT CONSULTING SERVICES' } } })]);
    const app = createApp(await testDeps(db));
    const get = async (q: string) => (await (await app.request(`/api/reference/naics?q=${encodeURIComponent(q)}`)).json()) as any;

    const all = await get('');
    expect(all.options.slice(0, 2).map((o: any) => o.code).sort()).toEqual(['236220', '541511']);
    expect(all.options.find((o: any) => o.code === '541511')).toMatchObject({ title: 'Custom Computer Programming Services', inProfile: true, sector: 'Professional, Scientific, and Technical Services' });

    expect((await get('5416')).options.map((o: any) => o.code)).toEqual(['541611']);
    const words = await get('management consulting');
    expect(words.options[0]).toMatchObject({ code: '541611', title: 'Administrative Management and General Management Consulting Services' });
    // Sector words find every code in that sector, and the sector itself.
    expect((await get('construction')).options.map((o: any) => o.code)).toEqual(expect.arrayContaining(['236220', '23']));
  });

  it('suggests agencies with preferred ones first', async () => {
    const db = await createTestDb();
    await setupCompany(db);
    await db.query(`UPDATE company_profiles SET preferred_agencies = '{"Department of Veterans Affairs"}'`);
    await db.query(`INSERT INTO agencies (name, name_key, level) VALUES ('Department of Homeland Security','DHS','department'), ('Department of Veterans Affairs','VA','department')`);
    const app = createApp(await testDeps(db));
    const r = (await (await app.request('/api/reference/agencies?q=department')).json()) as any;
    expect(r.options[0]).toMatchObject({ name: 'Department of Veterans Affairs', preferred: true });
    expect(r.options.map((o: any) => o.name)).toContain('Department of Homeland Security');
    const one = (await (await app.request('/api/reference/agencies?q=homeland')).json()) as any;
    expect(one.options.map((o: any) => o.name)).toEqual(['Department of Homeland Security']);
  });
});
