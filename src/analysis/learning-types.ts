import type { ProviderConfig } from '../types';

export interface SiteProfile {
  domain: string;
  pageTypes: Record<string, { confidence: number; signals: string[]; count: number }>;
  bestSelectors: { selector: string; successRate: number; attempts: number; phase: string }[];
  urlPatterns: { pattern: string; leadsTo: 'servers' | 'episodes' | 'download' | 'navigation'; count: number }[];
  embedDomains: string[];
  searchInputs: { selector: string; placeholder: string; method: string }[];
  avgResponseTime: number;
  visits: number;
  lastVisit: number;
  recommendedStrategy: 'static' | 'intelligent' | 'dynamic';
}

export interface NavigationNode {
  url: string;
  pageType: string;
  depth: number;
  children: string[];
  outboundUrls: string[];
  hasServers: boolean;
  serverCount: number;
}

export interface NavigationMap {
  domain: string;
  rootUrl: string;
  nodes: Record<string, NavigationNode>;
  edges: { from: string; to: string; label: string; action: string }[];
  paths: { from: string; to: string; steps: string[]; reliability: number }[];
}

export interface LearnedDomainEntry {
  domain: string;
  type: 'embed' | 'direct-video' | 'stream' | 'download' | 'cdn' | 'navigation';
  resolverMethod?: string;
  serverName?: string;
  confidence: number;
  firstSeen: number;
  lastSeen: number;
  successCount: number;
}

export interface LearnedSelector {
  selector: string;
  domain: string;
  phase: string;
  successRate: number;
  attempts: number;
  lastUsed: number;
}

export interface LearnedPattern {
  pattern: string;
  description: string;
  confidence: number;
  examples: string[];
  category: 'search-url' | 'episode-url' | 'video-container' | 'pagination' | 'player-detection';
}

export interface LearnedKnowledgeBase {
  domains: Record<string, LearnedDomainEntry>;
  selectors: LearnedSelector[];
  patterns: LearnedPattern[];
  totalDiscoveries: number;
  lastUpdated: number;
}

export interface ExportableProfile {
  version: number;
  exportedAt: number;
  providers: ProviderConfig[];
  siteProfiles: Record<string, SiteProfile>;
  navigationMaps: Record<string, NavigationMap>;
  learnedKB: LearnedKnowledgeBase;
}
