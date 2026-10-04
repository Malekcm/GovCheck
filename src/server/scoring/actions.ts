/**
 * Deterministic "what should we do next?" for a BD lead. Built only from facts already on the
 * profile (stage, dates, eligibility flags, documents, incumbent, decisions) — no AI required —
 * and every action states why it is recommended.
 */
export interface RecommendedAction {
  action: string;
  why: string;
  due: string | null;
  urgency: 'now' | 'soon' | 'later';
}

interface Input {
  opportunity: any;
  documents: any[];
  contacts: any[];
  requirements: any[];
  explanations: any[];
  vendors: any[];
  relationships: any[];
  currentDecision: any | null;
  capture?: any | null;
  now?: Date;
}

const day = (v: unknown) => (v ? new Date(String(v)).toISOString().slice(0, 10) : null);

export function recommendActions(d: Input): RecommendedAction[] {
  const o = d.opportunity;
  const now = d.now ?? new Date();
  const out: RecommendedAction[] = [];
  const add = (action: string, why: string, due: string | null = null, urgency: RecommendedAction['urgency'] = 'soon') => out.push({ action, why, due, urgency });
  const deadline = o.response_deadline ? new Date(o.response_deadline) : null;
  const daysLeft = deadline ? Math.round((deadline.getTime() - now.getTime()) / 86_400_000) : null;
  const decided = d.currentDecision?.decision as string | undefined;
  const closedDecision = decided && ['pass', 'not_eligible', 'duplicate_irrelevant', 'not_relevant'].includes(decided);
  const hardBlocks = d.explanations.filter((e) => e.kind === 'hard_block');
  const verify = d.explanations.filter((e) => e.kind === 'verify');
  const smallBizContact = d.contacts.find((c) => /small_business/.test(c.role));
  const co = d.contacts.find((c) => /contracting|primary|program/.test(c.role));

  if (o.status === 'cancelled') {
    add('Stop work on this pursuit and record a decision', 'The notice is cancelled (or marked no longer required) at the source.', null, 'now');
    return out;
  }
  if (closedDecision) return out;

  if (!decided && (o.priority_score ?? o.fit_score ?? 0) >= 50) add('Make a pursue / watch / pass decision', `Strong priority (${o.priority_score ?? o.fit_score}) and no decision recorded yet.`, deadline ? day(new Date(Math.min(deadline.getTime(), now.getTime() + 3 * 86_400_000))) : null, 'now');

  for (const h of hardBlocks.slice(0, 2)) add('Resolve eligibility blocker or plan to team', h.text, null, 'now');
  for (const v of verify.slice(0, 2)) add('Verify eligibility', v.text, null, 'soon');

  switch (o.stage) {
    case 'forecast':
    case 'grant_forecast':
      add(
        smallBizContact ? `Contact the small-business specialist (${smallBizContact.full_name ?? smallBizContact.email})` : 'Request a capability briefing with the agency small-business office (OSDBU)',
        'Forecast stage: the acquisition strategy and set-aside are still being decided.',
        null,
        'soon',
      );
      add('Set a watch for the Sources Sought / RFI', 'Responding to market research is the best chance to shape the requirement.', null, 'later');
      break;
    case 'recompete_signal':
      add('Research incumbent performance (CPARS references, protests, modifications) and customer pain points', 'An expiring contract with no successor notice yet — positioning is possible 12–18 months before expiry.', null, 'soon');
      add('Find the program office and request a meeting before the RFI', 'Early engagement precedes the formal procurement.', null, 'later');
      break;
    case 'sources_sought':
    case 'rfi':
      add('Submit a capability statement / RFI response', 'Market research responses influence set-aside decisions and requirements.', day(deadline), daysLeft != null && daysLeft <= 7 ? 'now' : 'soon');
      break;
    case 'presolicitation':
      add('Line up teammates and draft the outline before the RFP drops', 'Presolicitation notices usually precede the RFP by 15–45 days.', null, 'soon');
      break;
    case 'solicitation':
    case 'combined_synopsis':
    case 'subcontract':
    case 'grant_posted':
      if (daysLeft != null && daysLeft >= 0) add('Hold a bid / no-bid decision', `${daysLeft} day(s) until the response deadline.`, day(new Date(Math.min(deadline!.getTime(), now.getTime() + Math.max(1, Math.floor(daysLeft / 3)) * 86_400_000))), daysLeft <= 10 ? 'now' : 'soon');
      break;
  }

  const questionsDue = d.requirements.find((r) => r.category === 'question_deadline');
  if (questionsDue && o.stage !== 'award') add('Submit clarification questions', questionsDue.text, null, 'now');
  const pending = d.documents.filter((x) => x.retrieval_status !== 'downloaded');
  if (pending.length && ['solicitation', 'combined_synopsis', 'presolicitation', 'sources_sought', 'rfi'].includes(o.stage))
    add(`Review ${pending.length} solicitation document(s) not yet parsed`, 'Requirements, evaluation criteria and page limits usually live in the attachments.', null, 'soon');
  if (!d.documents.length && ['solicitation', 'combined_synopsis'].includes(o.stage)) add('Download the solicitation package from the source', 'No documents are captured for an active solicitation.', null, 'soon');
  if (d.requirements.some((r) => r.category === 'sole_source')) add('Decide whether to challenge the sole-source intent with a capability statement', 'The notice states an intent to award without full competition.', day(deadline), 'now');
  if (!d.vendors.length && (o.stage === 'solicitation' || o.stage === 'presolicitation' || o.recompete_signal)) add('Identify the incumbent (run "Refresh this opportunity" for award history)', 'No incumbent is linked yet.', null, 'later');
  if (o.value_low == null && o.value_high == null) add('Estimate the value from comparable awards', 'No official or estimated value is known.', null, 'later');
  if (!co && o.stage !== 'award' && o.opportunity_class !== 'intelligence') add('Find the contracting officer / point of contact', 'No contact is published on this profile.', null, 'later');
  if (o.opportunity_class === 'subcontract') add('Contact the prime directly', 'Subcontract opportunities are awarded by the prime contractor, not the government.', null, 'soon');
  if (d.capture?.next_action) add(d.capture.next_action, 'Your capture plan', day(d.capture.next_action_date), 'now');
  return out.slice(0, 10);
}
