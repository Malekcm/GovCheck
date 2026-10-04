import { DECISION_LABEL_VALUE, type Decision } from '../../shared/domain';
import type { Db } from '../db';
import { json } from '../db';
import { detectClearance, detectOnsite, detectVehicle } from '../ai/rules';
import { nameKey } from '../lib/text';
import { FEEDBACK_REASONS } from '../seed/capabilities';
import type { FitResult, OppForScoring } from './types';

export type FeatureVector = Record<string, number>;

export interface PreferenceModel {
  version: number;
  sampleCount: number;
  stage: 'base_only' | 'small' | 'moderate' | 'strong';
  alpha: number;
  bias: number;
  weights: Map<string, number>;
  metrics: Record<string, unknown>;
  createdAt: string;
}

export const EMPTY_MODEL: PreferenceModel = { version: 0, sampleCount: 0, stage: 'base_only', alpha: 0, bias: 0, weights: new Map(), metrics: {}, createdAt: new Date(0).toISOString() };

/**
 * Blend factor by number of reviewed opportunities. Deliberately conservative so a
 * handful of decisions cannot dominate ranking (avoids overfitting).
 */
export function stageForCount(n: number): { stage: PreferenceModel['stage']; alpha: number } {
  if (n === 0) return { stage: 'base_only', alpha: 0 };
  if (n < 10) return { stage: 'base_only', alpha: 0.06 };
  if (n < 25) return { stage: 'small', alpha: 0.2 };
  if (n < 50) return { stage: 'moderate', alpha: 0.35 };
  return { stage: 'strong', alpha: 0.55 };
}

export function valueBucket(v: number | null): string {
  if (v == null) return 'unknown';
  if (v < 100_000) return 'lt100k';
  if (v < 1_000_000) return '100k-1m';
  if (v < 5_000_000) return '1m-5m';
  if (v < 25_000_000) return '5m-25m';
  if (v < 100_000_000) return '25m-100m';
  return 'gt100m';
}

export const FEATURE_GROUP_LABELS: Record<string, string> = {
  comp: 'Score component',
  agency: 'Agency',
  subagency: 'Sub-agency',
  office: 'Office',
  naics: 'NAICS',
  naics4: 'NAICS group',
  psc2: 'PSC group',
  stage: 'Stage',
  class: 'Opportunity class',
  setaside: 'Set-aside',
  value: 'Value band',
  state: 'Location',
  vehicle: 'Contract vehicle',
  clearance: 'Clearance',
  cap: 'Capability',
  scope: 'Capability area',
  incumbent: 'Incumbent',
  travel: 'Travel / on-site',
  pricing: 'Pricing',
  cert: 'Certification',
};

export function featureGroup(feature: string): string {
  if (feature.startsWith('comp:')) return feature.split('=')[0];
  return feature.split(':')[0];
}

/** Interpretable features describing an opportunity (used for preference learning only). */
export function extractFeatures(opp: OppForScoring, fit: FitResult, extras: { hasIncumbent?: boolean } = {}): FeatureVector {
  const f: FeatureVector = {};
  for (const c of fit.components) f[`comp:${c.component}`] = Number((c.ratio - 0.5).toFixed(3));
  const put = (k: string) => (f[k] = 1);
  if (opp.department) put(`agency:${nameKey(opp.department)}`);
  if (opp.subtier) put(`subagency:${nameKey(opp.subtier)}`);
  if (opp.office) put(`office:${nameKey(opp.office)}`);
  if (opp.naics) {
    put(`naics:${opp.naics}`);
    put(`naics4:${opp.naics.slice(0, 4)}`);
  }
  if (opp.psc) put(`psc2:${opp.psc.slice(0, 2)}`);
  put(`stage:${opp.stage}`);
  put(`class:${opp.opportunityClass}`);
  put(`setaside:${opp.setAsideCode ?? 'none'}`);
  put(`value:${valueBucket(opp.valueHigh ?? opp.valueLow)}`);
  if (opp.placeState) put(`state:${opp.placeState.toUpperCase()}`);
  const text = `${opp.title}\n${opp.text}`;
  const vehicle = opp.contractVehicle ?? detectVehicle(text)?.name;
  if (vehicle) put(`vehicle:${vehicle}`);
  const cl = detectClearance(text);
  if (cl) put(`clearance:${cl.level}`);
  if (detectOnsite(text).onsite) put('travel:onsite');
  for (const m of fit.matchedCapabilities.slice(0, 12)) {
    put(`cap:${m.slug}`);
    put(`scope:${nameKey(m.category).toLowerCase().replace(/\s+/g, '-')}`);
  }
  if (extras.hasIncumbent) put('incumbent:yes');
  return f;
}

function sigmoid(z: number) {
  return 1 / (1 + Math.exp(-z));
}

interface Sample {
  x: FeatureVector;
  y: number;
  w: number;
}

/** L2-regularized logistic regression with soft labels (AdaGrad). */
export function trainLogistic(samples: Sample[], opts: { lambda?: number; iterations?: number; lr?: number } = {}): { weights: Map<string, number>; bias: number } {
  const lambda = opts.lambda ?? 1.0;
  const iterations = opts.iterations ?? 400;
  const lr = opts.lr ?? 0.3;
  const weights = new Map<string, number>();
  const g2 = new Map<string, number>();
  const totalW = samples.reduce((s, x) => s + x.w, 0) || 1;
  const meanY = samples.reduce((s, x) => s + x.y * x.w, 0) / totalW;
  let bias = Math.log((meanY + 0.01) / (1 - meanY + 0.01));
  let gb2 = 0;
  for (let it = 0; it < iterations; it++) {
    const grad = new Map<string, number>();
    let gb = 0;
    for (const s of samples) {
      let z = bias;
      for (const [k, v] of Object.entries(s.x)) z += (weights.get(k) ?? 0) * v;
      const err = (sigmoid(z) - s.y) * s.w;
      gb += err;
      for (const [k, v] of Object.entries(s.x)) grad.set(k, (grad.get(k) ?? 0) + err * v);
    }
    for (const [k, g] of grad) {
      const total = g / totalW + (lambda / totalW) * (weights.get(k) ?? 0);
      g2.set(k, (g2.get(k) ?? 0) + total * total);
      weights.set(k, (weights.get(k) ?? 0) - (lr * total) / (Math.sqrt(g2.get(k)!) + 1e-8));
    }
    gb /= totalW;
    gb2 += gb * gb;
    bias -= (lr * gb) / (Math.sqrt(gb2) + 1e-8);
  }
  for (const [k, v] of weights) if (Math.abs(v) < 1e-4) weights.delete(k);
  return { weights, bias };
}

export function predict(model: Pick<PreferenceModel, 'weights' | 'bias'>, x: FeatureVector): number {
  let z = model.bias;
  for (const [k, v] of Object.entries(x)) z += (model.weights.get(k) ?? 0) * v;
  return sigmoid(z);
}

export function contributions(model: Pick<PreferenceModel, 'weights'>, x: FeatureVector, n = 6): { feature: string; contribution: number }[] {
  return Object.entries(x)
    .map(([k, v]) => ({ feature: k, contribution: (model.weights.get(k) ?? 0) * v }))
    .filter((c) => Math.abs(c.contribution) > 0.01)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, n);
}

export function preferenceScore(fit: number, model: PreferenceModel, x: FeatureVector): { score: number; learned: number | null } {
  if (!model.version || model.alpha === 0) return { score: fit, learned: null };
  const p = predict(model, x);
  return { score: Math.round((1 - model.alpha) * fit + model.alpha * 100 * p), learned: p };
}

export function buildSamples(decisions: { decision: Decision; reasons: string[]; features: FeatureVector }[]): Sample[] {
  const reasonMap = new Map(FEEDBACK_REASONS.map((r) => [r.code, r]));
  const samples: Sample[] = [];
  for (const d of decisions) {
    const y = DECISION_LABEL_VALUE[d.decision];
    if (y == null) continue; // not a preference signal (e.g. "Not eligible", "Duplicate")
    samples.push({ x: d.features, y, w: 1 });
    // Reasons tell us WHICH aspects drove the decision: add targeted samples restricted
    // to the feature groups each reason speaks to.
    for (const code of d.reasons) {
      const r = reasonMap.get(code);
      if (!r || !r.groups.length) continue;
      const x: FeatureVector = {};
      for (const [k, v] of Object.entries(d.features)) if (r.groups.includes(featureGroup(k))) x[k] = v;
      if (Object.keys(x).length) samples.push({ x, y: r.polarity === 'positive' ? 0.9 : 0.1, w: 0.6 });
    }
  }
  return samples;
}

function evaluate(model: { weights: Map<string, number>; bias: number }, samples: Sample[]): { accuracy: number; logLoss: number } {
  let correct = 0;
  let loss = 0;
  for (const s of samples) {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, predict(model, s.x)));
    if (p >= 0.5 === s.y >= 0.5) correct++;
    loss += -(s.y * Math.log(p) + (1 - s.y) * Math.log(1 - p));
  }
  return { accuracy: samples.length ? correct / samples.length : 0, logLoss: samples.length ? loss / samples.length : 0 };
}

/** Train a new model version from all current decisions and persist it. */
export async function retrainPreferenceModel(
  db: Db,
  allDecisions: { decision: Decision; reasons: string[]; features: FeatureVector; fit: number }[],
  trigger: string,
): Promise<PreferenceModel> {
  // "Not eligible" / "Duplicate" / "Review later" carry no information about what work the user wants.
  const decisions = allDecisions.filter((d) => DECISION_LABEL_VALUE[d.decision] != null);
  const label = (d: { decision: Decision }) => DECISION_LABEL_VALUE[d.decision] as number;
  const n = decisions.length;
  const { stage, alpha } = stageForCount(n);
  const prev = await db.one<{ version: number }>('SELECT max(version) AS version FROM preference_models');
  const version = (prev?.version ?? 0) + 1;
  let weights = new Map<string, number>();
  let bias = 0;
  const metrics: Record<string, unknown> = { decisions: n, excludedNonPreferenceDecisions: allDecisions.length - n };
  if (n > 0) {
    const samples = buildSamples(decisions);
    ({ weights, bias } = trainLogistic(samples));
    const primary = decisions.map((d) => ({ x: d.features, y: label(d), w: 1 }));
    Object.assign(metrics, { training: evaluate({ weights, bias }, primary), samples: samples.length });
    // Baseline: does base fit alone (≥50 = positive) predict decisions?
    const baseCorrect = decisions.filter((d) => d.fit >= 50 === label(d) >= 0.5).length;
    metrics.baselineFitAccuracy = baseCorrect / n;
    if (n >= 15) {
      // 5-fold cross-validated accuracy (honest estimate of predictive value)
      let correct = 0;
      for (let k = 0; k < 5; k++) {
        const train = decisions.filter((_, i) => i % 5 !== k);
        const test = decisions.filter((_, i) => i % 5 === k);
        const m = trainLogistic(buildSamples(train), { iterations: 250 });
        correct += test.filter((d) => predict(m, d.features) >= 0.5 === label(d) >= 0.5).length;
      }
      metrics.crossValidatedAccuracy = correct / n;
    }
  }
  await db.tx(async (tx) => {
    await tx.query('UPDATE preference_models SET is_active = false WHERE is_active');
    const row = await tx.one<{ id: string }>(
      `INSERT INTO preference_models (version, sample_count, stage, blend_alpha, bias, metrics, trigger, is_active) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,true) RETURNING id`,
      [version, n, stage, alpha, bias, json(metrics), trigger],
    );
    const top = [...weights.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 600);
    const support = new Map<string, number>();
    for (const d of decisions) for (const k of Object.keys(d.features)) support.set(k, (support.get(k) ?? 0) + 1);
    if (top.length)
      await tx.query(
        `INSERT INTO preference_weights (model_id, feature, weight, support) SELECT $1, x.feature, x.weight, x.support FROM jsonb_to_recordset($2::jsonb) AS x(feature text, weight numeric, support int)`,
        [row!.id, json(top.map(([feature, weight]) => ({ feature, weight: Number(weight.toFixed(5)), support: support.get(feature) ?? 0 })))],
      );
  });
  return { version, sampleCount: n, stage, alpha, bias, weights, metrics, createdAt: new Date().toISOString() };
}

export async function loadActiveModel(db: Db): Promise<PreferenceModel> {
  const m = await db.one<any>('SELECT * FROM preference_models WHERE is_active ORDER BY version DESC LIMIT 1');
  if (!m) return EMPTY_MODEL;
  const ws = await db.query<{ feature: string; weight: number }>('SELECT feature, weight FROM preference_weights WHERE model_id = $1', [m.id]);
  return {
    version: m.version,
    sampleCount: m.sample_count,
    stage: m.stage,
    alpha: Number(m.blend_alpha),
    bias: Number(m.bias),
    weights: new Map(ws.map((w) => [w.feature, Number(w.weight)])),
    metrics: m.metrics ?? {},
    createdAt: m.created_at,
  };
}
