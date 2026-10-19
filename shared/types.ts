export type Status = 'active' | 'paused';
export type Device = 'desktop' | 'mobile' | 'tablet';
export type CrawlerProvider = 'google' | 'meta';
export interface CrawlerRouting { enabled: boolean; url: string; providers: CrawlerProvider[]; }
export interface Destination { id: string; name: string; url: string; status: Status; dailyCap: number; createdAt: string; clicksToday: number; }
export interface Rule { id: string; name: string; enabled: boolean; source: string; device: '' | Device; targets: { destinationId: string; weight: number }[]; }
export interface Campaign { id: string; name: string; slug: string; source: string; status: Status; costPerClick: number; fallbackId: string; rules: Rule[]; crawlerRouting: CrawlerRouting; postbackToken: string; createdAt: string; clicks: number; conversions: number; revenue: number; cost: number; }
export interface Click { id: string; campaignId: string; campaignName: string; destinationId: string; destinationName: string; ruleName: string; device: Device; source: string; externalId: string; cost: number; createdAt: string; converted: number; }
export interface Conversion { id: string; clickId: string; campaignId: string; campaignName: string; transactionId: string; revenue: number; status: 'approved' | 'rejected'; createdAt: string; }
export interface Article { id: string; title: string; slug: string; excerpt: string; body: string; status: 'draft' | 'published'; campaignId: string; cta: string; origin: 'manual' | 'ai'; createdAt: string; updatedAt: string; publishedAt: string | null; }
export interface Settings { siteName: string; siteDescription: string; aiBaseUrl: string; aiModel: string; hasApiKey: boolean; }
export interface Summary { clicks: number; uniqueVisitors: number; conversions: number; revenue: number; cost: number; profit: number; series: { date: string; clicks: number; conversions: number }[]; campaigns: Campaign[]; destinations: Destination[]; recent: Click[]; }
export interface Decision { campaign: Campaign; ruleName: string; destination: Destination; eligible: { id: string; name: string; weight: number }[]; fallback: boolean; }
export type TrafficDecision = ({ kind: 'visitor' } & Decision) | { kind: 'crawler'; campaign: Campaign; ruleName: string; provider: CrawlerProvider; url: string; evidence: 'user-agent-only' };
export interface CrawlerRequest { id: string; campaignId: string; campaignName: string; provider: CrawlerProvider; userAgent: string; destinationUrl: string; source: string; createdAt: string; }
export interface Bootstrap { campaigns: Campaign[]; destinations: Destination[]; articles: Article[]; settings: Settings; }
