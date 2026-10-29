import type { Assessment, BrowserFacts, IdentityEvidence, RequestFacts, TrafficConfig } from '../../shared/traffic.ts';

export function assess(facts: RequestFacts, identity: IdentityEvidence, config: TrafficConfig, count: number | null, browser: BrowserFacts | null = null, now = Date.now(), networkKinds: ('deny' | 'hosting' | 'proxy')[] = []): Assessment {
  const reasons: string[] = []; const coverage = ['request-headers']; let score = 0;
  if (facts.ip) coverage.push('client-ip');
  if (identity.status === 'verified') { reasons.push('verified-crawler-origin'); coverage.push('provider-verification'); }
  else if (identity.claimedProvider) reasons.push(identity.status === 'unverified' ? 'crawler-claim-not-verified' : 'crawler-verification-unknown');
  if (facts.edge.verifiedBot === true) { reasons.push('edge-verified-bot'); coverage.push('edge-bot-verification'); }
  if (facts.edge.score !== null) { coverage.push('edge-score'); if (facts.edge.score < 30) { reasons.push('edge-low-bot-score'); score += 25; } }
  for (const kind of networkKinds) { reasons.push(`network-${kind}`); score += kind === 'deny' ? 100 : 15; }
  if (!facts.userAgent) { reasons.push('user-agent-missing'); score += 5; }
  if (!facts.accept) { reasons.push('accept-header-missing'); score += 5; }
  if (count !== null) { coverage.push('rate-window'); if (count > config.requestsPerMinute) { reasons.push('request-rate-exceeded'); score += 60; } }
  if (browser) {
    coverage.push('browser-observations');
    if (browser.webdriver === true) { reasons.push('browser-reports-automation'); score += 30; }
    const language = facts.language?.split(',')[0]?.split(';')[0]?.toLowerCase();
    if (language && browser.language && language.split('-')[0] !== browser.language.toLowerCase().split('-')[0]) { reasons.push('language-inconsistency'); score += 10; }
    if (browser.platform && facts.platformHint && browser.platform.toLowerCase() !== facts.platformHint.replaceAll('"', '').toLowerCase()) { reasons.push('platform-inconsistency'); score += 10; }
    if (browser.errors.length) reasons.push('browser-observations-partial');
  }
  // Verification establishes origin, not harm. Never restrict a verified beneficial crawler by heuristic risk.
  const verified = identity.status === 'verified' || facts.edge.verifiedBot === true;
  const risk = verified ? 'low' : score >= 60 ? 'high' : score >= 25 ? 'medium' : (browser || facts.authority === 'cloudflare-signed') ? 'low' : 'unknown';
  return {
    version: 'rules-1', identity, automation: verified || browser?.webdriver === true || score >= 60 ? 'suspected' : browser ? 'not-established' : 'unknown',
    risk, score: risk === 'unknown' ? null : Math.min(score, 100), scoreKind: 'heuristic', reasons: [...new Set(reasons)], coverage,
    recommendedAction: risk === 'high' ? config.highRiskAction : 'allow', assessedAt: new Date(now).toISOString(),
  };
}
