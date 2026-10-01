import type { Db } from '../db';
import { nameKey } from '../lib/text';
import type { NormalizedAgency, NormalizedAwardee, NormalizedContact } from '../connectors/types';

export interface AgencyRefs {
  agencyId: string | null;
  subagencyId: string | null;
  officeId: string | null;
}

async function upsertAgency(db: Db, level: 'department' | 'subtier', name: string, code: string | null, parentId: string | null): Promise<string> {
  const key = nameKey(name);
  const row = await db.one<{ id: string }>(
    `INSERT INTO agencies (level, name, name_key, code, parent_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (level, name_key) DO UPDATE SET code = COALESCE(agencies.code, EXCLUDED.code), parent_id = COALESCE(agencies.parent_id, EXCLUDED.parent_id)
     RETURNING id`,
    [level, name, key, code, parentId],
  );
  return row!.id;
}

/** Resolve (creating as needed) department → subtier → office records. */
export async function resolveAgency(db: Db, a: NormalizedAgency, officeAddress?: { city?: string | null; state?: string | null; zip?: string | null } | null): Promise<AgencyRefs> {
  let agencyId: string | null = null;
  let subagencyId: string | null = null;
  let officeId: string | null = null;
  if (a.department && nameKey(a.department)) agencyId = await upsertAgency(db, 'department', a.department, a.departmentCode ?? null, null);
  if (a.subtier && nameKey(a.subtier) && nameKey(a.subtier) !== nameKey(a.department)) subagencyId = await upsertAgency(db, 'subtier', a.subtier, a.subtierCode ?? null, agencyId);
  const parent = subagencyId ?? agencyId;
  if (a.office && nameKey(a.office) && parent) {
    const row = await db.one<{ id: string }>(
      `INSERT INTO agency_offices (agency_id, name, name_key, code, city, state, zip) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (agency_id, name_key) DO UPDATE SET code = COALESCE(agency_offices.code, EXCLUDED.code),
         city = COALESCE(agency_offices.city, EXCLUDED.city), state = COALESCE(agency_offices.state, EXCLUDED.state), zip = COALESCE(agency_offices.zip, EXCLUDED.zip)
       RETURNING id`,
      [parent, a.office, nameKey(a.office), a.officeCode ?? null, officeAddress?.city ?? null, officeAddress?.state ?? null, officeAddress?.zip ?? null],
    );
    officeId = row!.id;
  }
  return { agencyId, subagencyId, officeId };
}

export async function upsertVendor(db: Db, v: NormalizedAwardee): Promise<string | null> {
  if (!v.name && !v.uei) return null;
  const name = v.name ?? v.uei!;
  const key = nameKey(name);
  if (v.uei) {
    const row = await db.one<{ id: string }>(
      `INSERT INTO vendors (name, name_key, uei, cage, parent_uei, parent_name, city, state, business_types)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[])
       ON CONFLICT (uei) DO UPDATE SET name = EXCLUDED.name, name_key = EXCLUDED.name_key,
         cage = COALESCE(EXCLUDED.cage, vendors.cage), parent_uei = COALESCE(EXCLUDED.parent_uei, vendors.parent_uei),
         parent_name = COALESCE(EXCLUDED.parent_name, vendors.parent_name), city = COALESCE(EXCLUDED.city, vendors.city),
         state = COALESCE(EXCLUDED.state, vendors.state),
         business_types = CASE WHEN cardinality(EXCLUDED.business_types) > 0 THEN EXCLUDED.business_types ELSE vendors.business_types END,
         last_seen_at = now()
       RETURNING id`,
      [name, key, v.uei.toUpperCase(), v.cage ?? null, v.parentUei ?? null, v.parentName ?? null, v.city ?? null, v.state ?? null, v.businessTypes ?? []],
    );
    // Fold any name-only placeholder vendor into this UEI vendor.
    return row!.id;
  }
  const existing = await db.one<{ id: string }>('SELECT id FROM vendors WHERE name_key = $1 ORDER BY (uei IS NULL) ASC, first_seen_at ASC LIMIT 1', [key]);
  if (existing) return existing.id;
  const row = await db.one<{ id: string }>('INSERT INTO vendors (name, name_key) VALUES ($1,$2) RETURNING id', [name, key]);
  return row!.id;
}

export function contactKey(c: NormalizedContact): string | null {
  if (c.email && /@/.test(c.email)) return `email:${c.email.trim().toLowerCase()}`;
  const name = nameKey(c.fullName);
  if (!name) return null;
  return `name:${name}|${nameKey(c.organization) || ''}|${(c.phone ?? '').replace(/\D/g, '')}`;
}

export async function upsertContact(db: Db, c: NormalizedContact): Promise<string | null> {
  const key = contactKey(c);
  if (!key) return null;
  const row = await db.one<{ id: string }>(
    `INSERT INTO contacts (contact_key, full_name, title, email, phone, fax, organization) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (contact_key) DO UPDATE SET full_name = COALESCE(EXCLUDED.full_name, contacts.full_name), title = COALESCE(EXCLUDED.title, contacts.title),
       phone = COALESCE(EXCLUDED.phone, contacts.phone), fax = COALESCE(EXCLUDED.fax, contacts.fax), organization = COALESCE(EXCLUDED.organization, contacts.organization), updated_at = now()
     RETURNING id`,
    [key, c.fullName ?? null, c.title ?? null, c.email?.trim() ?? null, c.phone ?? null, c.fax ?? null, c.organization ?? null],
  );
  return row!.id;
}
