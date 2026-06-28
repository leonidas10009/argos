import type { SmartScrapeResult, ExplorationStep } from './AutonomousScraper';
import type { NavigationMap, NavigationNode } from './learning-types';
import { getLogger } from '../utils/logger';

export class NavigationMapper {
  /**
   * Build a navigation graph from exploration steps.
   * Maps how pages were discovered and what actions led to content.
   */
  buildMap(result: SmartScrapeResult, rootUrl: string): NavigationMap {
    const domain = this.extractDomain(rootUrl);
    const nodes: Record<string, NavigationNode> = {};
    const edges: NavigationMap['edges'] = [];
    let currentUrl = rootUrl;

    nodes[rootUrl] = this.createNode(rootUrl, 'root', 0);

    for (const step of result.steps) {
      const stepUrl = this.extractStepUrl(step, currentUrl);

      if (!nodes[stepUrl]) {
        nodes[stepUrl] = this.createNode(stepUrl, this.inferPageType(step), 0);
      }

      // Connect edge: currentUrl → stepUrl
      const edgeLabel = step.action === 'navigate'
        ? `navigate: ${step.reasoning.slice(0, 40)}`
        : step.action === 'dive'
          ? 'dive: container'
          : step.action;

      edges.push({
        from: currentUrl,
        to: stepUrl,
        label: edgeLabel,
        action: step.action,
      });

      // Add child relationship
      if (!nodes[currentUrl]!.children.includes(stepUrl)) {
        nodes[currentUrl]!.children.push(stepUrl);
      }

      // Track outbound URLs
      if (step.result?.newUrls) {
        for (const u of step.result.newUrls) {
          if (!nodes[stepUrl]!.outboundUrls.includes(u)) {
            nodes[stepUrl]!.outboundUrls.push(u);
          }
        }
      }

      // Update current URL for next step
      if (step.action === 'navigate' || step.action === 'dive') {
        currentUrl = stepUrl;
      }
    }

    // Calculate depths (BFS from root)
    this.calculateDepths(nodes, rootUrl);

    // Mark nodes with servers
    this.markServerNodes(nodes, result);

    // Compute paths between root and server nodes
    const paths = this.computePaths(nodes, edges, rootUrl);

    getLogger().info({
      nodes: Object.keys(nodes).length,
      edges: edges.length,
      paths: paths.length,
      domain,
    }, 'NavigationMap built');

    return { domain, rootUrl, nodes, edges, paths };
  }

  /**
   * Merge a new map into an existing one, accumulating knowledge.
   */
  merge(existing: NavigationMap, newMap: NavigationMap): NavigationMap {
    const merged = { ...existing };

    // Merge nodes
    for (const [url, node] of Object.entries(newMap.nodes)) {
      if (merged.nodes[url]) {
        merged.nodes[url]!.children = [...new Set([...merged.nodes[url]!.children, ...node.children])];
        merged.nodes[url]!.outboundUrls = [...new Set([...merged.nodes[url]!.outboundUrls, ...node.outboundUrls])];
        merged.nodes[url]!.hasServers = merged.nodes[url]!.hasServers || node.hasServers;
        merged.nodes[url]!.serverCount = Math.max(merged.nodes[url]!.serverCount, node.serverCount);
      } else {
        merged.nodes[url] = node;
      }
    }

    // Merge edges (deduplicate by from+to+action)
    const edgeKeys = new Set(merged.edges.map(e => `${e.from}|${e.to}|${e.action}`));
    for (const e of newMap.edges) {
      const key = `${e.from}|${e.to}|${e.action}`;
      if (!edgeKeys.has(key)) {
        merged.edges.push(e);
        edgeKeys.add(key);
      }
    }

    // Merge paths (keep highest reliability)
    const pathKeys = new Map<string, number>();
    for (const p of merged.paths) {
      pathKeys.set(`${p.from}|${p.to}`, merged.paths.indexOf(p));
    }
    for (const p of newMap.paths) {
      const key = `${p.from}|${p.to}`;
      const existingIdx = pathKeys.get(key);
      if (existingIdx === undefined) {
        merged.paths.push(p);
      } else if (p.reliability > merged.paths[existingIdx]!.reliability) {
        merged.paths[existingIdx] = p;
      }
    }

    return merged;
  }

  private createNode(url: string, pageType: string, depth: number): NavigationNode {
    return { url, pageType, depth, children: [], outboundUrls: [], hasServers: false, serverCount: 0 };
  }

  private extractStepUrl(step: ExplorationStep, fallback: string): string {
    if (step.action === 'navigate' && step.reasoning.includes('http')) {
      const match = step.reasoning.match(/(https?:\/\/[^\s"]+)/);
      if (match) return match[1]!;
    }
    if (step.action === 'dive' && step.reasoning.includes('http')) {
      const match = step.reasoning.match(/(https?:\/\/[^\s"]+)/);
      if (match) return match[1]!;
    }
    return step.target.startsWith('http') ? step.target : fallback;
  }

  private inferPageType(step: ExplorationStep): string {
    if (/listing|cards|many-links/i.test(step.reasoning)) return 'listing';
    if (/detail|episodes|synopsis|genres/i.test(step.reasoning)) return 'detail';
    if (/content|servers|player|iframe/i.test(step.reasoning)) return 'content';
    return 'unknown';
  }

  private calculateDepths(nodes: Record<string, NavigationNode>, rootUrl: string): void {
    const visited = new Set<string>();
    const queue: [string, number][] = [[rootUrl, 0]];
    while (queue.length > 0) {
      const [url, depth] = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      if (nodes[url]) nodes[url]!.depth = depth;
      for (const child of (nodes[url]?.children || [])) {
        queue.push([child, depth + 1]);
      }
    }
  }

  private markServerNodes(nodes: Record<string, NavigationNode>, result: SmartScrapeResult): void {
    for (const server of result.serverCatalog) {
      for (const entry of server.urls) {
        if (entry.type === 'embed' || entry.type === 'stream' || entry.type === 'direct-video') {
          for (const [, node] of Object.entries(nodes)) {
            if (entry.url.includes(node.url) || node.url.includes(this.extractDomain(entry.url))) {
              node.hasServers = true;
              node.serverCount++;
            }
          }
        }
      }
    }

    // Also mark nodes that led to server captures
    for (const step of result.steps) {
      if (step.action === 'content-servers' || /servers?/i.test(step.reasoning)) {
        const stepUrl = this.extractStepUrl(step, '');
        if (nodes[stepUrl]) {
          nodes[stepUrl]!.hasServers = true;
          nodes[stepUrl]!.serverCount = Math.max(nodes[stepUrl]!.serverCount, 1);
        }
      }
    }
  }

  private computePaths(
    nodes: Record<string, NavigationNode>,
    edges: NavigationMap['edges'],
    rootUrl: string,
  ): NavigationMap['paths'] {
    const paths: NavigationMap['paths'] = [];
    const serverNodes = Object.entries(nodes).filter(([, n]) => n.hasServers);

    for (const [serverUrl] of serverNodes) {
      // BFS from root to find shortest path to server node
      const path = this.bfs(nodes, edges, rootUrl, serverUrl);
      if (path) {
        paths.push({
          from: rootUrl,
          to: serverUrl,
          steps: path,
          reliability: Math.max(0.5, 1 - path.length * 0.1),
        });
      }
    }

    return paths;
  }

  private bfs(
    nodes: Record<string, NavigationNode>,
    edges: NavigationMap['edges'],
    from: string,
    to: string,
  ): string[] | null {
    const visited = new Set<string>();
    const queue: [string, string[]][] = [[from, [from]]];

    while (queue.length > 0) {
      const [current, path] = queue.shift()!;
      if (current === to) return path;
      if (visited.has(current)) continue;
      visited.add(current);

      const outgoingEdges = edges.filter(e => e.from === current);
      for (const e of outgoingEdges) {
        if (!visited.has(e.to)) {
          queue.push([e.to, [...path, e.to]]);
        }
      }
    }
    return null;
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  }
}
