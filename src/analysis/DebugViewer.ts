import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Page } from 'puppeteer';
import { getLogger } from '../utils/logger';
import type { SmartScrapeResult } from './AutonomousScraper';

interface DebugSnapshot {
  step: number;
  action: string;
  target: string;
  reasoning: string;
  screenshot: string;
  url: string;
  urlsFound: string[];
}

export class DebugViewer {
  private snapshots: DebugSnapshot[] = [];
  private outputDir: string;
  private baseUrl: string;

  constructor(outputDir = './debug') {
    this.outputDir = outputDir;
    this.baseUrl = '';
    mkdirSync(outputDir, { recursive: true });
    // Limpiar archivos anteriores (uno por uno, mas robusto que rmSync)
    try {
      const files = readdirSync(outputDir);
      for (const f of files) {
        if (f.endsWith('.png') || f.endsWith('.html')) {
          try { unlinkSync(join(outputDir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  async capture(
    page: Page,
    step: number,
    action: string,
    target: string,
    reasoning: string,
    urlsFound: string[],
  ): Promise<void> {
    try {
      const filename = `step_${String(step).padStart(3, '0')}_${action}.png`;
      const filepath = join(this.outputDir, filename);
      await page.screenshot({ path: filepath, fullPage: false });
      const url = page.url();

      this.snapshots.push({
        step,
        action,
        target,
        reasoning,
        screenshot: filename,
        url,
        urlsFound,
      });
    } catch (err) {
      getLogger().debug({ error: (err as Error).message }, 'DebugViewer: screenshot failed');
    }
  }

  generateReport(result: SmartScrapeResult): string {
    const relativeBase = relative(process.cwd(), this.outputDir).replace(/\\/g, '/');

    const stepsHtml = this.snapshots.map(s => {
      const newUrls = s.urlsFound.length > 0
        ? `<div class="new-urls">+${s.urlsFound.length} URLs</div>`
        : '';
      return `
      <div class="step" onclick="showStep(${s.step})" id="step-btn-${s.step}">
        <span class="step-num">${s.step}</span>
        <span class="step-action ${s.action}">${s.action}</span>
        <span class="step-target">${escapeHtml(s.target.slice(0, 40))}</span>
        ${newUrls}
      </div>`;
    }).join('');

    const screenshotsHtml = this.snapshots.map(s => `
      <div class="screenshot-panel" id="ss-${s.step}" style="display:none">
        <h3>[${s.step}] ${s.action}: ${escapeHtml(s.reasoning.slice(0, 80))}</h3>
        <div class="screenshot-meta">
          URL: <code>${escapeHtml(s.url.slice(0, 100))}</code>
          ${s.urlsFound.length > 0 ? `| <b>${s.urlsFound.length} URLs nuevas</b>` : ''}
        </div>
        <img src="${relativeBase}/${s.screenshot}" class="screenshot-img" loading="lazy" />
        ${s.urlsFound.length > 0 ? `
        <div class="url-list">
          <h4>URLs descubiertas:</h4>
          ${s.urlsFound.map(u => `<div class="url-item">${escapeHtml(u.slice(0, 120))}</div>`).join('')}
        </div>` : ''}
      </div>`).join('');

    const findings = result.findings || { videoUrls: [], downloadUrls: [], serverUrls: [], navigationUrls: [], otherUrls: [] };
    const catalogRows = (result.serverCatalog || []).slice(0, 10).map(s => {
      const types: Record<string, number> = {};
      (s.urls || []).forEach(u => { types[u.type] = (types[u.type] || 0) + 1; });
      const typeStr = Object.entries(types).map(([k, v]) => `${v}x ${k}`).join(', ');
      return `<tr>
        <td><b>${escapeHtml(s.name)}</b></td>
        <td>${s.urls.length}</td>
        <td>${escapeHtml(typeStr)}</td>
        <td>${s.urls.slice(0, 3).map(u => escapeHtml(u.url.slice(0, 60))).join('<br>')}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Scraper Debug - ${escapeHtml(result.title || result.url)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#eee;display:flex;height:100vh;overflow:hidden}
.sidebar{width:300px;background:#16213e;overflow-y:auto;padding:10px;flex-shrink:0}
.sidebar h2{color:#0f3460;padding:10px 0;border-bottom:2px solid #0f3460;margin-bottom:10px;font-size:14px;text-transform:uppercase;letter-spacing:1px}
.step{cursor:pointer;padding:8px 10px;margin:4px 0;border-radius:6px;background:#1a1a2e;display:flex;align-items:center;gap:8px;font-size:12px;transition:background .2s}
.step:hover{background:#0f3460}
.step.active{background:#e94560}
.step-num{background:#0f3460;color:#e94560;padding:2px 6px;border-radius:4px;font-weight:bold;min-width:30px;text-align:center}
.step-action{padding:2px 6px;border-radius:3px;font-size:10px;text-transform:uppercase}
.step-action.search{background:#00b4d8}
.step-action.click{background:#e94560}
.step-action.group{background:#7209b7}
.step-action.explore{background:#f72585}
.step-action.dive{background:#4cc9f0}
.step-action.deep-group{background:#7209b7}
.step-target{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#aaa}
.new-urls{background:#06d6a0;color:#000;padding:2px 5px;border-radius:3px;font-size:10px;font-weight:bold}
.main{flex:1;overflow-y:auto;padding:20px}
.main h1{font-size:18px;margin-bottom:4px}
.main .subtitle{color:#aaa;font-size:12px;margin-bottom:20px}
.screenshot-panel{margin-bottom:30px;border:1px solid #0f3460;border-radius:8px;padding:15px;background:#16213e}
.screenshot-panel h3{font-size:14px;color:#e94560;margin-bottom:8px}
.screenshot-meta{font-size:11px;color:#aaa;margin-bottom:12px}
.screenshot-meta code{background:#0f3460;padding:2px 6px;border-radius:3px}
.screenshot-img{max-width:100%;border-radius:6px;border:1px solid #0f3460}
.url-list{margin-top:12px}
.url-list h4{font-size:12px;color:#06d6a0;margin-bottom:6px}
.url-item{font-size:11px;color:#ccc;padding:3px 8px;background:#1a1a2e;border-radius:4px;margin:2px 0;word-break:break-all;font-family:monospace}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:20px 0}
.summary-card{background:#16213e;border-radius:8px;padding:12px;text-align:center}
.summary-card .num{font-size:28px;font-weight:bold;color:#e94560}
.summary-card .label{font-size:10px;color:#aaa;text-transform:uppercase;margin-top:4px}
table{width:100%;border-collapse:collapse;margin-top:15px;font-size:12px}
th{background:#0f3460;padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase}
td{padding:8px 10px;border-bottom:1px solid #0f3460}
tr:hover td{background:#1a1a2e}
.empty-state{text-align:center;padding:60px 20px;color:#555}
.empty-state h2{font-size:48px;margin-bottom:10px}
</style>
</head>
<body>
<div class="sidebar">
  <h2>Pasos (${this.snapshots.length})</h2>
  ${stepsHtml}
  <h2 style="margin-top:20px">Resumen</h2>
  <div style="font-size:11px;color:#aaa;padding:8px">
    Video: ${findings.videoUrls.length} |
    Download: ${findings.downloadUrls.length}<br>
    Server: ${findings.serverUrls.length} |
    Nav: ${findings.navigationUrls.length}<br>
    Otros: ${findings.otherUrls.length}<br>
    Servidores: ${(result.serverCatalog || []).length}
  </div>
</div>
<div class="main">
  <h1>${escapeHtml(result.title || 'Sin titulo')}</h1>
  <div class="subtitle">${escapeHtml(result.url)} | ${result.durationMs}ms | ${result.steps.length} pasos | ${result.model.totalElements} elementos</div>

  <div class="summary">
    <div class="summary-card"><div class="num">${result.steps.length}</div><div class="label">Pasos</div></div>
    <div class="summary-card"><div class="num">${findings.serverUrls.length}</div><div class="label">Servers</div></div>
    <div class="summary-card"><div class="num">${findings.videoUrls.length}</div><div class="label">Videos</div></div>
    <div class="summary-card"><div class="num">${findings.downloadUrls.length}</div><div class="label">Downloads</div></div>
    <div class="summary-card"><div class="num">${(result.serverCatalog || []).length}</div><div class="label">Catalogo</div></div>
    <div class="summary-card"><div class="num">${result.durationMs}ms</div><div class="label">Duracion</div></div>
  </div>

  ${(result.serverCatalog || []).length > 0 ? `
  <h3 style="color:#06d6a0;margin-top:20px">Catalogo de Servidores</h3>
  <table>
    <tr><th>Servidor</th><th>URLs</th><th>Tipos</th><th>Ejemplos</th></tr>
    ${catalogRows}
  </table>` : ''}

  ${this.snapshots.length > 0 ? `
  <h3 style="color:#e94560;margin-top:30px">Linea de tiempo</h3>
  ${screenshotsHtml}
  ` : `
  <div class="empty-state">
    <h2>📸</h2>
    <p>Activa el modo debug para ver screenshots de cada paso</p>
  </div>`}
</div>
<script>
function showStep(n) {
  document.querySelectorAll('.screenshot-panel').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
  var panel = document.getElementById('ss-' + n);
  var btn = document.getElementById('step-btn-' + n);
  if (panel) panel.style.display = 'block';
  if (btn) btn.classList.add('active');
}
// Mostrar primer paso
if (${this.snapshots.length} > 0) showStep(${this.snapshots[0]?.step || 0});
</script>
</body>
</html>`;

    const htmlPath = join(this.outputDir, 'index.html');
    writeFileSync(htmlPath, html);
    getLogger().info({ path: htmlPath }, 'Debug report generated');

    return htmlPath;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
