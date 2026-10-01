import type { Stage } from '../../../shared/domain';
import { parseDate, toIso } from '../../lib/dates';
import { parseMoney } from '../../lib/money';
import { htmlToText, looksLikeHtml, sanitizeExternalHtml, titleCase } from '../../lib/text';
import type { NormalizedContact, NormalizedDocument, NormalizedIdentifier, NormalizedOpportunity } from '../types';

/** Source-agnostic intermediate shape for a SAM Contract Opportunities notice (API JSON or bulk CSV row). */
export interface SamNotice {
  noticeId: string;
  title: string;
  solicitationNumber?: string | null;
  type?: string | null;
  baseType?: string | null;
  postedDate?: string | null;
  updatedDate?: string | null;
  responseDeadline?: string | null;
  archiveType?: string | null;
  archiveDate?: string | null;
  active?: boolean | null;
  naics: string[];
  classificationCode?: string | null;
  setAsideCode?: string | null;
  setAside?: string | null;
  department?: string | null;
  departmentCode?: string | null;
  subtier?: string | null;
  subtierCode?: string | null;
  office?: string | null;
  officeCode?: string | null;
  fullParentPathName?: string | null;
  organizationType?: string | null;
  officeAddress?: { city?: string | null; state?: string | null; zip?: string | null; country?: string | null } | null;
  place?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null; country?: string | null } | null;
  description?: string | null; // text/html
  descriptionUrl?: string | null;
  uiLink?: string | null;
  additionalInfoLink?: string | null;
  resourceLinks: string[];
  contacts: NormalizedContact[];
  award?: { number?: string | null; amount?: number | null; date?: string | null; awardeeName?: string | null; awardeeUei?: string | null; awardeeCity?: string | null; awardeeState?: string | null } | null;
  extra: Record<string, unknown>;
}

const RFI_RE = /\b(RFI|request\s+for\s+information)\b/i;
const RFQ_RE = /\b(RFQ|request\s+for\s+quot(e|ation)s?)\b/i;
const RFP_RE = /\b(RFP|request\s+for\s+proposals?)\b/i;

export function samTypeToStage(type: string | null | undefined, baseType: string | null | undefined, title: string): { stage: Stage; basis?: string } {
  const t = `${type ?? ''} ${baseType ?? ''}`.toLowerCase();
  if (t.includes('award')) return { stage: 'award' };
  if (t.includes('combined')) return { stage: 'combined_synopsis' };
  if (t.includes('presolicitation') || t.includes('pre-solicitation') || t.includes('pre solicitation')) return { stage: 'presolicitation' };
  if (t.includes('sources sought')) {
    return RFI_RE.test(title) ? { stage: 'rfi', basis: 'Official notice type is Sources Sought; title identifies it as an RFI.' } : { stage: 'sources_sought' };
  }
  if (t.includes('special notice')) {
    return RFI_RE.test(title) ? { stage: 'rfi', basis: 'Official notice type is Special Notice; title identifies it as an RFI.' } : { stage: 'special_notice' };
  }
  if (t.includes('solicitation')) return { stage: 'solicitation' };
  return { stage: 'other' };
}

/** Additional derived procurement form (RFP/RFQ/RFI) detected from the title. */
export function detectRequestForm(title: string): string | null {
  if (RFI_RE.test(title)) return 'RFI';
  if (RFQ_RE.test(title)) return 'RFQ';
  if (RFP_RE.test(title)) return 'RFP';
  return null;
}

function splitPath(path: string | null | undefined): string[] {
  return (path ?? '')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function samNoticeToNormalized(n: SamNotice): NormalizedOpportunity {
  const { stage, basis } = samTypeToStage(n.type, n.baseType, n.title);
  const deadline = parseDate(n.responseDeadline);
  const archive = parseDate(n.archiveDate);
  const now = Date.now();

  let status: NormalizedOpportunity['status'] = 'active';
  if (stage === 'award') status = 'awarded';
  else if (n.active === false || (archive && archive.getTime() < now)) status = 'archived';
  else if (deadline && deadline.getTime() < now) status = 'closed';

  const pathParts = splitPath(n.fullParentPathName);
  const department = n.department ?? pathParts[0] ?? null;
  const subtier = n.subtier ?? (pathParts.length > 1 ? pathParts[1] : null);
  const office = n.office ?? (pathParts.length > 2 ? pathParts[pathParts.length - 1] : null);

  const identifiers: NormalizedIdentifier[] = [{ type: 'notice_id', value: n.noticeId }];
  if (n.solicitationNumber) identifiers.push({ type: 'solicitation_number', value: n.solicitationNumber });
  if (n.award?.number) identifiers.push({ type: 'award_number', value: n.award.number });

  const description = n.description ? (looksLikeHtml(n.description) ? sanitizeExternalHtml(n.description) : n.description.trim()) : null;

  const documents: NormalizedDocument[] = n.resourceLinks.map((url) => ({ url, requiresSamKey: /sam\.gov\/api/i.test(url), docType: null }));

  const financials: NormalizedOpportunity['financials'] = [];
  if (n.award?.amount != null) financials.push({ kind: 'award_value', low: n.award.amount, high: n.award.amount, label: 'Award amount (SAM award notice)' });

  const dates: NormalizedOpportunity['dates'] = [];
  if (n.postedDate) dates.push({ kind: 'posted', value: toIso(n.postedDate) });
  if (n.updatedDate) dates.push({ kind: 'updated', value: toIso(n.updatedDate) });
  if (n.responseDeadline) dates.push({ kind: 'response_due', value: toIso(n.responseDeadline) });
  if (n.archiveDate) dates.push({ kind: 'archive', value: toIso(n.archiveDate) });
  if (n.award?.date) dates.push({ kind: 'award_date', value: toIso(n.award.date) });

  const links: NormalizedOpportunity['links'] = [];
  if (n.uiLink) links.push({ url: n.uiLink, label: 'SAM.gov notice' });
  if (n.additionalInfoLink) links.push({ url: n.additionalInfoLink, label: 'Additional information' });

  const requestForm = detectRequestForm(n.title);

  return {
    opportunityClass: 'prime',
    stage,
    stageBasis: basis,
    noticeType: n.type ?? null,
    status,
    title: n.title?.trim() || `SAM notice ${n.noticeId}`,
    description,
    descriptionUrl: n.descriptionUrl ?? null,
    identifiers,
    agency: {
      department: department ? titleCase(department) : null,
      departmentCode: n.departmentCode ?? null,
      subtier: subtier ? titleCase(subtier) : null,
      subtierCode: n.subtierCode ?? null,
      office: office ? titleCase(office) : null,
      officeCode: n.officeCode ?? null,
      fullPath: n.fullParentPathName ?? null,
    },
    naics: n.naics.filter(Boolean),
    psc: n.classificationCode || null,
    setAsideCode: n.setAsideCode && n.setAsideCode !== 'NONE' ? n.setAsideCode : null,
    // An explicit official "no set-aside" is kept (it is different from unknown).
    setAside: n.setAsideCode === 'NONE' || (n.setAside && /^no set.?aside/i.test(n.setAside)) ? 'No set-aside' : n.setAside ?? null,
    dates,
    financials,
    place: n.place ?? null,
    officeAddress: n.officeAddress ?? null,
    contacts: n.contacts,
    documents,
    links,
    url: n.uiLink ?? `https://sam.gov/opp/${n.noticeId}/view`,
    award: n.award?.number || n.award?.awardeeName
      ? {
          awardKey: `sam_notice:${n.noticeId}`,
          piid: n.award.number ?? null,
          solicitationId: n.solicitationNumber ?? null,
          awardee: { name: n.award.awardeeName ?? null, uei: n.award.awardeeUei ?? null, city: n.award.awardeeCity ?? null, state: n.award.awardeeState ?? null },
          dollarsObligated: n.award.amount ?? null,
          dateSigned: n.award.date ? toIso(n.award.date)?.slice(0, 10) ?? null : null,
          agency: { department, subtier, office },
          naics: n.naics[0] ?? null,
          psc: n.classificationCode ?? null,
          setAside: n.setAside ?? null,
        }
      : null,
    extra: { ...n.extra, requestForm, organizationType: n.organizationType ?? undefined, archiveType: n.archiveType ?? undefined, baseType: n.baseType ?? undefined },
  };
}

// ---------------------------------------------------------------------------
// API JSON -> SamNotice
// ---------------------------------------------------------------------------
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function nameOf(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return str(v);
  if (typeof v === 'object') return str((v as any).name) ?? str((v as any).code);
  return null;
}

export function samApiItemToNotice(item: any): SamNotice {
  const naics: string[] = [];
  if (item.naicsCode) naics.push(String(item.naicsCode));
  if (Array.isArray(item.naicsCodes)) for (const c of item.naicsCodes) if (c && !naics.includes(String(c))) naics.push(String(c));

  const descRaw = str(item.description);
  const isDescUrl = !!descRaw && /^https?:\/\//i.test(descRaw);

  const contacts: NormalizedContact[] = (Array.isArray(item.pointOfContact) ? item.pointOfContact : []).map((c: any) => ({
    role: str(c.type) ?? 'primary',
    fullName: str(c.fullName),
    title: str(c.title),
    email: str(c.email),
    phone: str(c.phone),
    fax: str(c.fax),
  }));

  const pop = item.placeOfPerformance ?? null;
  const award = item.award
    ? {
        number: str(item.award.number),
        amount: parseMoney(item.award.amount),
        date: str(item.award.date),
        awardeeName: str(item.award.awardee?.name),
        awardeeUei: str(item.award.awardee?.ueiSAM ?? item.award.awardee?.uei),
        awardeeCity: nameOf(item.award.awardee?.location?.city),
        awardeeState: nameOf(item.award.awardee?.location?.state),
      }
    : null;

  return {
    noticeId: String(item.noticeId),
    title: str(item.title) ?? '',
    solicitationNumber: str(item.solicitationNumber),
    type: str(item.type),
    baseType: str(item.baseType),
    postedDate: str(item.postedDate),
    updatedDate: str(item.updatedDate ?? item.modifiedDate),
    responseDeadline: str(item.responseDeadLine ?? item.responseDeadline),
    archiveType: str(item.archiveType),
    archiveDate: str(item.archiveDate),
    active: item.active === undefined ? null : String(item.active).toLowerCase() === 'yes' || item.active === true,
    naics,
    classificationCode: str(item.classificationCode),
    setAsideCode: str(item.typeOfSetAside),
    setAside: str(item.typeOfSetAsideDescription),
    department: str(item.department),
    subtier: str(item.subTier ?? item.subtier),
    office: str(item.office),
    fullParentPathName: str(item.fullParentPathName),
    departmentCode: str(item.fullParentPathCode)?.split('.')[0] ?? null,
    subtierCode: str(item.fullParentPathCode)?.split('.')[1] ?? null,
    officeCode: str(item.fullParentPathCode)?.split('.').slice(-1)[0] ?? null,
    organizationType: str(item.organizationType),
    officeAddress: item.officeAddress
      ? { city: str(item.officeAddress.city), state: str(item.officeAddress.state), zip: str(item.officeAddress.zipcode ?? item.officeAddress.zip), country: str(item.officeAddress.countryCode) }
      : null,
    place: pop
      ? {
          street: str(pop.streetAddress),
          city: nameOf(pop.city),
          state: str(pop.state?.code) ?? nameOf(pop.state),
          zip: str(pop.zip),
          country: str(pop.country?.code) ?? nameOf(pop.country),
        }
      : null,
    description: isDescUrl ? null : descRaw,
    descriptionUrl: isDescUrl ? descRaw : null,
    uiLink: str(item.uiLink),
    additionalInfoLink: str(item.additionalInfoLink),
    resourceLinks: Array.isArray(item.resourceLinks) ? item.resourceLinks.filter((u: unknown) => typeof u === 'string') : [],
    contacts,
    award,
    extra: {},
  };
}

// ---------------------------------------------------------------------------
// Bulk CSV row -> SamNotice
// ---------------------------------------------------------------------------
export function samCsvRowToNotice(row: Record<string, string>): SamNotice {
  const g = (k: string) => str(row[k]);
  const contacts: NormalizedContact[] = [];
  if (g('PrimaryContactFullname') || g('PrimaryContactEmail'))
    contacts.push({ role: 'primary', fullName: g('PrimaryContactFullname'), title: g('PrimaryContactTitle'), email: g('PrimaryContactEmail'), phone: g('PrimaryContactPhone'), fax: g('PrimaryContactFax') });
  if (g('SecondaryContactFullname') || g('SecondaryContactEmail'))
    contacts.push({ role: 'secondary', fullName: g('SecondaryContactFullname'), title: g('SecondaryContactTitle'), email: g('SecondaryContactEmail'), phone: g('SecondaryContactPhone'), fax: g('SecondaryContactFax') });
  const awardNumber = g('AwardNumber');
  const awardee = g('Awardee');
  const description = g('Description');
  return {
    noticeId: g('NoticeId') ?? '',
    title: g('Title') ?? '',
    solicitationNumber: g('Sol#'),
    type: g('Type'),
    baseType: g('BaseType'),
    postedDate: g('PostedDate'),
    responseDeadline: g('ResponseDeadLine'),
    archiveType: g('ArchiveType'),
    archiveDate: g('ArchiveDate'),
    active: g('Active') ? g('Active')!.toLowerCase() === 'yes' : null,
    naics: g('NaicsCode') ? [g('NaicsCode')!] : [],
    classificationCode: g('ClassificationCode'),
    setAsideCode: g('SetASideCode'),
    setAside: g('SetASide'),
    department: g('Department/Ind.Agency'),
    departmentCode: g('CGAC'),
    subtier: g('Sub-Tier'),
    subtierCode: g('FPDS Code'),
    office: g('Office'),
    officeCode: g('AAC Code'),
    organizationType: g('OrganizationType'),
    officeAddress: { city: g('City'), state: g('State'), zip: g('ZipCode'), country: g('CountryCode') },
    place: g('PopCity') || g('PopState') || g('PopZip') ? { street: g('PopStreetAddress'), city: g('PopCity'), state: g('PopState'), zip: g('PopZip'), country: g('PopCountry') } : null,
    description: description ? htmlToText(description) : null,
    uiLink: g('Link'),
    additionalInfoLink: g('AdditionalInfoLink'),
    resourceLinks: [],
    contacts,
    award: awardNumber || awardee ? { number: awardNumber, amount: parseMoney(g('Award$')), date: g('AwardDate'), awardeeName: awardee } : null,
    extra: {},
  };
}
