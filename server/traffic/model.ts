import { createHash } from 'node:crypto';
import type { Store } from '../store.ts';
import type { Assessment } from '../../shared/traffic.ts';

const features = ['network-deny', 'network-hosting', 'network-proxy', 'request-rate-exceeded', 'browser-reports-automation', 'language-inconsistency', 'platform-inconsistency', 'edge-low-bot-score', 'user-agent-missing', 'accept-header-missing'] as const;
export interface LabeledExample { id: string; session: string; at: string; label: 'legitimate' | 'abusive'; reasons: string[]; baselineHigh: boolean; }
function interval(positive: number, total: number) {
  if (!total) return null; const z = 1.96; const p = positive / total; const d = 1 + z * z / total;
  const middle = (p + z * z / (2 * total)) / d; const radius = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d;
  return { lower: Math.max(0, middle - radius), upper: Math.min(1, middle + radius), samples: total };
}
function metrics(rows: LabeledExample[], predict: (row: LabeledExample) => number) {
  let tp = 0; let fp = 0; let tn = 0; let fn = 0; let brier = 0;
  for (const r of rows) { const p = predict(r); const actual = r.label === 'abusive'; if (p >= .5) { if (actual) tp++; else fp++; } else { if (actual) fn++; else tn++; } brier += (p - Number(actual)) ** 2; }
  return { tp, fp, tn, fn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null, falsePositiveRate: fp + tn ? fp / (fp + tn) : null, precisionInterval: interval(tp, tp + fp), falsePositiveInterval: interval(fp, fp + tn), brierScore: rows.length ? brier / rows.length : null };
}
export function evaluateExamples(rows: LabeledExample[]) {
  if (rows.length < 200) return { state: 'not-enough-data' as const, samples: rows.length, reason: 'Collect at least 200 independently labeled requests before model evaluation. No model is activated.' };
  const ordered = [...rows].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const cutoff = ordered[Math.floor(ordered.length * .7)].at;
  const bounds = new Map<string, { first: string; last: string }>();
  for (const r of ordered) { const b = bounds.get(r.session); if (!b) bounds.set(r.session, { first: r.at, last: r.at }); else b.last = r.at; }
  const train = ordered.filter(r => bounds.get(r.session)!.last < cutoff);
  const test = ordered.filter(r => bounds.get(r.session)!.first >= cutoff);
  const counts = (set: LabeledExample[]) => ({ legitimate: set.filter(r => r.label === 'legitimate').length, abusive: set.filter(r => r.label === 'abusive').length });
  const training = counts(train); const holdout = counts(test);
  if (Math.min(training.legitimate, training.abusive) < 30 || Math.min(holdout.legitimate, holdout.abusive) < 20) return { state: 'not-enough-data' as const, samples: rows.length, training, holdout, reason: 'Need at least 30 labels of each class in training and 20 of each in a later, session-separated holdout.' };
  const probability = (label: LabeledExample['label']) => features.map(feature => (train.filter(r => r.label === label && r.reasons.includes(feature)).length + 1) / (training[label] + 2));
  const legitimate = probability('legitimate'); const abusive = probability('abusive');
  const prior = (training.abusive + 1) / (train.length + 2);
  const predict = (r: LabeledExample) => {
    let a = Math.log(prior); let l = Math.log(1 - prior);
    features.forEach((feature, i) => { const present = r.reasons.includes(feature); a += Math.log(present ? abusive[i] : 1 - abusive[i]); l += Math.log(present ? legitimate[i] : 1 - legitimate[i]); });
    return 1 / (1 + Math.exp(Math.max(-700, Math.min(700, l - a))));
  };
  const candidate = metrics(test, predict);
  const baseline = metrics(test, r => r.baselineHigh ? 1 : 0);
  const eligible = (candidate.precisionInterval?.lower ?? 0) >= .99 && (candidate.falsePositiveInterval?.upper ?? 1) <= .01 && (candidate.recall ?? 0) > (baseline.recall ?? 0) && (candidate.falsePositiveRate ?? 1) <= (baseline.falsePositiveRate ?? 1);
  return { state: 'evaluated' as const, algorithm: 'bernoulli-naive-bayes-1', activated: false, eligibleForReview: eligible, probabilityKind: 'uncalibrated-model-posterior', features, model: { prior, legitimate, abusive }, samples: rows.length, training, holdout, excludedOverlapping: rows.length - train.length - test.length, cutoff, candidate, baseline, reason: eligible ? 'Candidate meets the offline gate; independent review is still required before runtime integration.' : 'Candidate has not demonstrated the required improvement and uncertainty bounds. Runtime remains rules-only.', datasetDigest: createHash('sha256').update(JSON.stringify(ordered)).digest('hex') };
}
export async function evaluateModel(store: Store) {
  const count = Number((await store.db.prepare("SELECT count(DISTINCT request_id) n FROM relay.traffic_labels").get())!.n);
  if (count > 20000) return { state: 'capacity-limit', reason: 'This local evaluator accepts at most 20000 labeled requests. Export a bounded study before evaluating a larger corpus.' };
  const rows = (await store.db.prepare(`SELECT r.id,r.session_key,r.created_at,l.label,a.assessment FROM relay.traffic_requests r JOIN relay.traffic_labels l ON l.sequence=(SELECT max(sequence) FROM relay.traffic_labels WHERE request_id=r.id) JOIN relay.traffic_assessments a ON a.sequence=(SELECT max(sequence) FROM relay.traffic_assessments WHERE request_id=r.id AND created_at<=l.created_at) ORDER BY r.created_at,r.id`).all());
  const examples: LabeledExample[] = rows.map(r => { const assessment = JSON.parse(String(r.assessment)) as Assessment; return { id: String(r.id), session: String(r.session_key), at: String(r.created_at), label: r.label as LabeledExample['label'], reasons: assessment.reasons, baselineHigh: assessment.risk === 'high' }; });
  return evaluateExamples(examples);
}
