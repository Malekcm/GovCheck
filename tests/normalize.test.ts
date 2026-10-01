import { describe, expect, it } from 'vitest';
import { samApiItemToNotice, samCsvRowToNotice, samNoticeToNormalized, samTypeToStage } from '../src/server/connectors/sam/common';
import { normalizeSamAward, samAwardKey } from '../src/server/connectors/sam/samAwards';
import { normalizeUsaspendingAward } from '../src/server/connectors/usaspending';
import { normalizeForecast } from '../src/server/connectors/gsaForecast';
import { normalizeGrant } from '../src/server/connectors/grantsGov';
import { parseSubnetDetail, parseSubnetListing, sbaSubnetAdapter } from '../src/server/connectors/sbaSubnet';
import { parseFeedItems, normalizeFeedItem } from '../src/server/connectors/genericFeed';
import { normalizeIdentifier } from '../src/server/lib/ids';
import { parseMoneyRange } from '../src/server/lib/money';
import { parseDate } from '../src/server/lib/dates';
import { isAllowedByRules, parseRobots } from '../src/server/lib/robots';
import { fixture, fixtureJson } from './helpers/setup';

describe('SAM Contract Opportunities normalization', () => {
  const item = fixtureJson('sam_opportunity_sources_sought.json');

  it('maps the official notice into a normalized opportunity with full agency hierarchy', () => {
    const n = samNoticeToNormalized(samApiItemToNotice(item));
    expect(n.opportunityClass).toBe('prime');
    expect(n.noticeType).toBe('Sources Sought');
    expect(n.agency.department).toBe('Homeland Security, Department OF'.replace('OF', 'of'));
    expect(n.agency.subtier).toBe('US Customs and Border Protection');
    expect(n.agency.office).toBe('Enterprise Services Procurement Division');
    expect(n.agency.officeCode).toBe('70RDAD');
    expect(n.naics).toEqual(['541511']);
    expect(n.psc).toBe('DA01');
    expect(n.setAsideCode).toBe('SBA');
    expect(n.place).toMatchObject({ city: 'Washington', state: 'DC', zip: '20229' });
    expect(n.contacts[0]).toMatchObject({ role: 'primary', fullName: 'Jane Smith', email: 'jane.smith@cbp.dhs.gov', title: 'Contracting Officer' });
    expect(n.identifiers).toEqual(expect.arrayContaining([
      { type: 'notice_id', value: item.noticeId },
      { type: 'solicitation_number', value: '70RDAD-26-RFI-0042' },
    ]));
    expect(n.descriptionUrl).toContain('noticedesc');
    expect(n.documents[0].requiresSamKey).toBe(true);
    expect(n.dates.find((d) => d.kind === 'response_due')?.value).toBe('2026-06-20T21:00:00.000Z');
  });

  it('derives RFI stage from the title but records the basis (never silently)', () => {
    const n = samNoticeToNormalized(samApiItemToNotice(item));
    expect(n.stage).toBe('rfi');
    expect(n.stageBasis).toMatch(/Sources Sought/);
  });

  it('maps notice types onto the procurement lifecycle', () => {
    expect(samTypeToStage('Presolicitation', null, 'x').stage).toBe('presolicitation');
    expect(samTypeToStage('Combined Synopsis/Solicitation', null, 'x').stage).toBe('combined_synopsis');
    expect(samTypeToStage('Award Notice', null, 'x').stage).toBe('award');
    expect(samTypeToStage('Solicitation', null, 'x').stage).toBe('solicitation');
    expect(samTypeToStage('Special Notice', null, 'Industry Day').stage).toBe('special_notice');
  });

  it('normalizes bulk CSV rows identically to the API shape', () => {
    const header = fixture('sam_bulk_head.csv').trim().split(',').map((h) => h.replace(/"/g, ''));
    expect(header).toContain('NoticeId');
    const row: Record<string, string> = Object.fromEntries(header.map((h) => [h, '']));
    Object.assign(row, {
      NoticeId: 'abc123',
      Title: 'Data Warehouse Modernization',
      'Sol#': 'W912DY-26-R-0001',
      'Department/Ind.Agency': 'DEPT OF DEFENSE',
      'Sub-Tier': 'DEPT OF THE ARMY',
      Office: 'W076 ENDIST HUNTSVILLE',
      Type: 'Solicitation',
      PostedDate: '2026-09-01 10:00:00',
      ResponseDeadLine: '2026-10-15T14:00:00-05:00',
      NaicsCode: '541512',
      SetASideCode: '8A',
      SetASide: '8(a) Set-Aside (FAR 19.8)',
      Active: 'Yes',
      PrimaryContactFullname: 'John Doe',
      PrimaryContactEmail: 'john.doe@usace.army.mil',
      Description: '<p>The contractor shall modernize the data warehouse.</p>',
      Link: 'https://sam.gov/workspace/contract/opp/abc123/view',
    });
    const n = samNoticeToNormalized(samCsvRowToNotice(row));
    expect(n.stage).toBe('solicitation');
    expect(n.setAsideCode).toBe('8A');
    expect(n.description).toBe('The contractor shall modernize the data warehouse.');
    expect(n.contacts[0].email).toBe('john.doe@usace.army.mil');
    expect(n.agency.subtier).toBe('Dept of the Army');
  });
});

describe('Award normalization', () => {
  it('normalizes a USAspending award detail (real fixture)', () => {
    const detail = fixtureJson('usaspending_award_detail.json');
    const a = normalizeUsaspendingAward({ search: { generated_internal_id: detail.generated_unique_award_id }, detail });
    expect(a.piid).toBe('70B02C26F00000035');
    expect(a.referencedIdvPiid).toBe('70B02C20D00000019');
    expect(a.awardKey).toBe('piid:70B02C20D00000019:70B02C26F00000035');
    expect(a.awardee.uei).toBe('KC3CH2MSK7Q3');
    expect(a.totalObligated).toBe(362974500);
    expect(a.popCurrentEnd).toBe('2027-06-17');
    expect(a.agency.subtier).toBe('U.S. Customs and Border Protection');
    expect(a.naics).toBe('541512');
    expect(a.psc).toBe('Y1BG');
    expect(detail.executive_details).toBeUndefined(); // personal data stripped
  });

  it('normalizes a SAM Contract Awards record and keys award families by IDV + PIID', () => {
    const item = {
      contractId: { piid: '70RDAD24F00000123', modificationNumber: 'P00002', referencedIDVPiid: '47QTCA19D00AB', subtier: { code: '7014', name: 'U.S. CUSTOMS AND BORDER PROTECTION' } },
      coreData: {
        solicitationId: '70RDAD-24-Q-0042',
        awardOrIDVType: { code: 'C', name: 'DELIVERY ORDER' },
        federalOrganization: { contractingInformation: { contractingDepartment: { code: '7000', name: 'HOMELAND SECURITY, DEPARTMENT OF' }, contractingSubtier: { code: '7014', name: 'U.S. CUSTOMS AND BORDER PROTECTION' }, contractingOffice: { code: '70RDAD', name: 'ENTERPRISE SERVICES PROCUREMENT DIVISION' } } },
        productOrServiceInformation: { principalNaics: [{ code: '541511', name: 'CUSTOM COMPUTER PROGRAMMING' }], productOrService: { code: 'DA01', name: 'IT' } },
        acquisitionData: { typeOfContractPricing: { code: 'J', name: 'FIRM FIXED PRICE' } },
        competitionInformation: { extentCompeted: { code: 'A', name: 'FULL AND OPEN COMPETITION' }, typeOfSetAside: { code: 'SBA', name: 'SMALL BUSINESS SET ASIDE - TOTAL' } },
      },
      awardDetails: {
        dates: { dateSigned: '2024-03-01', periodOfPerformanceStartDate: '2024-03-15', currentCompletionDate: '2027-03-14', ultimateCompletionDate: '2029-03-14' },
        dollars: { actionObligation: '250000' },
        totalContractDollars: { totalActionObligation: '1750000', totalBaseAndAllOptionsValue: '4900000' },
        awardeeData: { awardeeHeader: { legalBusinessName: 'ACME ANALYTICS LLC' }, awardeeUEIInformation: { uniqueEntityId: 'ABCDEF123456', cageCode: '1ABC2' } },
        competitionInformation: { numberOfOffersReceived: '4' },
        transactionData: { lastModifiedDate: '2026-05-01' },
      },
    };
    const a = normalizeSamAward(item);
    expect(samAwardKey(item)).toBe('piid:47QTCA19D00AB:70RDAD24F00000123');
    expect(a).toMatchObject({ piid: '70RDAD24F00000123', solicitationId: '70RDAD-24-Q-0042', totalObligated: 1750000, baseAndAllOptions: 4900000, numberOfOffers: 4, pricingType: 'FIRM FIXED PRICE' });
    expect(a.awardee).toMatchObject({ name: 'ACME ANALYTICS LLC', uei: 'ABCDEF123456', cage: '1ABC2' });
    expect(a.popCurrentEnd).toBe('2027-03-14');
  });
});

describe('Other source normalizers (real fixtures)', () => {
  it('GSA forecast → forecast-stage profile with an official value band', () => {
    const row = fixtureJson('gsa_forecast_page.json').listing.data[0];
    const n = normalizeForecast(row);
    expect(n.stage).toBe('forecast');
    expect(n.status).toBe('forecast');
    expect(n.identifiers[0].type).toBe('forecast_id');
    expect(n.naics.length).toBeGreaterThan(0);
    const fin = n.financials.find((f) => f.kind === 'forecast_estimate');
    if (fin) expect(fin.high).toBeGreaterThanOrEqual(fin.low!);
  });

  it('SBA SUBNet listing + detail → SUBCONTRACT class', () => {
    const { rows } = parseSubnetListing(fixture('subnet_listing.html'));
    expect(rows.length).toBe(10);
    expect(rows[0]).toMatchObject({ title: 'RFI 243824 Safety and Compliance Training Courses Provider', businessName: 'Pacific Gas and Electric Company', closingDate: '11/4/2026' });
    const detail = parseSubnetDetail(fixture('subnet_detail.html'));
    expect(detail.naics[0].code).toBe('611430');
    expect(detail.attachments[0].filename).toMatch(/\.pdf$/);
    const result = sbaSubnetAdapter.normalize({ sourceRecordId: 'x', kind: 'subcontract', raw: rows[0], rawText: fixture('subnet_detail.html'), retrievedAt: new Date() });
    expect(result?.type).toBe('opportunity');
    const n = (result as any).data;
    expect(n.opportunityClass).toBe('subcontract');
    expect(n.primeContractor.name).toBe('Pacific Gas and Electric Company');
    expect(n.place.state).toBe('CA');
    expect(n.contacts[0].fullName).toBe('Shannon Tyler-Zabel');
  });

  it('Grants.gov → grant class with ceiling/floor/total funding and attachments', () => {
    const detail = fixtureJson('grants_fetch.json').data;
    const n = normalizeGrant({ hit: { id: String(detail.id), number: detail.opportunityNumber, title: detail.opportunityTitle, oppStatus: 'posted' }, detail });
    expect(n.opportunityClass).toBe('grant');
    expect(n.stage).toBe('grant_posted');
    expect(n.financials.map((f) => f.kind)).toEqual(expect.arrayContaining(['grant_ceiling', 'grant_floor', 'grant_total_funding']));
    expect(n.documents.length).toBeGreaterThan(0);
    expect(n.documents[0].url).toMatch(/grantsws\/rest\/opportunity\/att\/download\//);
    expect(n.eligibility).toContain('State governments');
  });

  it('generic RSS feed connector maps items with configurable fields', () => {
    const rss = `<?xml version="1.0"?><rss><channel><item><title>RFP 26-014 Data Dashboard Services</title><link>https://example.gov/bids/26-014</link><guid>26-014</guid><description>Seeking dashboard development.</description><pubDate>Mon, 14 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const items = parseFeedItems(rss, { url: 'https://example.gov/feed', format: 'rss' });
    expect(items).toHaveLength(1);
    const n = normalizeFeedItem(items[0], { url: 'x', format: 'rss', jurisdiction: 'City of Example' }, 'Example City Bids');
    expect(n.title).toBe('RFP 26-014 Data Dashboard Services');
    expect(n.identifiers[0].type).toBe('feed_item_id');
    expect(n.agency.department).toBe('City of Example');
  });
});

describe('Utilities', () => {
  it('normalizes identifiers cautiously', () => {
    expect(normalizeIdentifier('solicitation_number', 'W912DY-24-R-0001')).toBe('W912DY24R0001');
    expect(normalizeIdentifier('piid', ' 36c10b22n0051 ')).toBe('36C10B22N0051');
    expect(normalizeIdentifier('solicitation_number', 'N/A')).toBeNull();
    expect(normalizeIdentifier('solicitation_number', 'TBD')).toBeNull();
    expect(normalizeIdentifier('solicitation_number', 'AB-1')).toBeNull(); // too short to match safely
    expect(normalizeIdentifier('notice_id', 'abc-def')).toBe('ABC-DEF'); // opaque IDs keep punctuation
    expect(normalizeIdentifier('solicitation_number', 'ABC/123/456')).toBe('ABC/123/456'); // slashes kept
  });

  it('parses money bands and dates from many source formats', () => {
    expect(parseMoneyRange('$5M - $9.9M')).toEqual({ low: 5_000_000, high: 9_900_000 });
    expect(parseMoneyRange('Under $250K')).toEqual({ low: 0, high: 250_000 });
    expect(parseDate('Sep 21, 2026 12:00:00 AM EDT')?.toISOString()).toBe('2026-09-21T04:00:00.000Z');
    expect(parseDate('11/4/2026')?.toISOString().slice(0, 10)).toBe('2026-11-04');
    expect(parseDate('1790875240')?.getUTCFullYear()).toBe(2026);
  });

  it('honours robots.txt rules (SBA disallows file downloads)', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /sites/default/files/*\nAllow: /core/*.css$\n');
    expect(isAllowedByRules(rules, '/sites/default/files/subnet/x.pdf')).toBe(false);
    expect(isAllowedByRules(rules, '/opportunity/abc')).toBe(true);
  });
});
