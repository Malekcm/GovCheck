import { z } from 'zod';

const Evidence = z.object({
  text: z.string().describe('The requirement or fact, stated concisely.'),
  evidence_quote: z.string().nullable().describe('Verbatim quote (max ~200 chars) from the source text supporting this item, or null.'),
  document: z.string().nullable().describe('Name of the document the quote came from, or null for the notice description.'),
  page: z.number().int().nullable().describe('Page number if known from [Page N] markers, else null.'),
});

export const OpportunityExtraction = z.object({
  work_summary: z.string().nullable().describe('Plain-English summary of what the work is (2-4 sentences). Null if the text does not say.'),
  customer_need: z.string().nullable().describe('What the customer appears to need, in plain English. Null if unclear.'),
  likely_responsibilities: z.array(z.string()).describe('What the contractor would likely be responsible for. Empty if unknown.'),
  objectives: z.array(Evidence),
  tasks: z.array(Evidence),
  workstreams: z.array(Evidence),
  deliverables: z.array(Evidence),
  mandatory_requirements: z.array(Evidence),
  technical_requirements: z.array(Evidence),
  technologies: z.array(z.string()).describe('Named technologies, products, platforms, languages.'),
  systems: z.array(z.string()).describe('Named government systems involved.'),
  labor_categories: z.array(Evidence),
  staffing: z.string().nullable(),
  key_personnel: z.array(Evidence),
  security_clearance: Evidence.nullable(),
  certifications: z.array(Evidence),
  contract_vehicle: Evidence.nullable(),
  contract_type: Evidence.nullable(),
  pricing_information: Evidence.nullable(),
  period_of_performance: Evidence.nullable(),
  option_periods: Evidence.nullable(),
  place_of_performance: Evidence.nullable(),
  travel: Evidence.nullable(),
  performance_standards: z.array(Evidence),
  reporting_requirements: z.array(Evidence),
  compliance_requirements: z.array(Evidence),
  submission_deadline: Evidence.nullable(),
  questions_deadline: Evidence.nullable(),
  page_limits: z.array(Evidence),
  required_volumes: z.array(Evidence),
  submission_method: Evidence.nullable(),
  forms_and_representations: z.array(Evidence),
  evaluation_criteria: z.array(Evidence),
  contacts: z.array(z.object({ name: z.string().nullable(), role: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() })),
  risks: z.array(z.string()).describe('Risks or concerns a bidder should consider, grounded in the text.'),
  missing_information: z.array(z.string()).describe('Important facts a bidder would want that the text does NOT provide.'),
});

export type OpportunityExtractionT = z.infer<typeof OpportunityExtraction>;

export interface AiInput {
  title: string;
  agency: string | null;
  noticeType: string | null;
  description: string;
  documents: { name: string; text: string }[];
}

export interface AiResult<T> {
  status: 'success' | 'refused' | 'failed';
  output: T | null;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  model: string;
}

/** Provider abstraction: the application works fully without one; AI only adds understanding. */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  readonly promptVersion: string;
  extractOpportunity(input: AiInput): Promise<AiResult<OpportunityExtractionT>>;
}
