import { defineConfig, loadEnv, type Plugin } from 'vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { VitePWA } from 'vite-plugin-pwa';
import type { OutputBundle } from 'rollup';
import { resolve, dirname, extname } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { brotliCompress } from 'zlib';
import { promisify } from 'util';
import pkg from './package.json';
import { getSentryBuildMetadata } from './shared/sentry-build-metadata';
import { VARIANT_META, type VariantMeta } from './src/config/variant-meta';
import {
  WEB_DASHBOARD_VARIANTS,
  renderVariantDashboardHtml,
  variantDashboardFileName,
} from './src/config/variant-dashboard-html';
// Single source of truth for the RSS proxy allowlist — the dev-server proxy
// below reuses the SAME www-tolerant predicate the Edge handler enforces
// (api/rss-proxy.js) so dev and prod agree on allow/deny. Previously a
// hand-maintained Set here had drifted ~138 domains from prod.
import { isAllowedDomain } from './api/_rss-allowed-domain-match.js';
import { rssFetchHeadersForHost } from './api/_rss-fetch-headers.js';
import { validateGeneratedRequest } from './server/request-validator';
import {
  getChunkSizeWarning,
  isExpectedEmptyRpcClientWarning,
} from './scripts/vite-build-warning-policy.mts';

// Env-dependent constants moved inside defineConfig function


const brotliCompressAsync = promisify(brotliCompress);
const BROTLI_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.txt', '.xml', '.wasm']);
const STATIC_SCRIPT_NONCE = 'wm-static-bootstrap';

// @clerk/clerk-js is loaded as a UMD bundle from the Clerk Frontend API at
// runtime (src/services/clerk.ts), not bundled. Resolve the version from
// package.json so the runtime SDK matches the @clerk/clerk-js types we compile
// against, and inject it via `define` (__CLERK_JS_VERSION__). Fall back to
// devDependencies in case the (types-only) dep is moved there, and fail the
// build loudly if it can't be resolved — an empty version yields a `.../@/dist`
// URL that 404s and silently breaks auth in production.
const CLERK_DEPS = pkg.dependencies as Record<string, string>;
const CLERK_DEV_DEPS = (pkg.devDependencies ?? {}) as Record<string, string>;
const CLERK_JS_VERSION = (CLERK_DEPS['@clerk/clerk-js'] || CLERK_DEV_DEPS['@clerk/clerk-js'] || '')
  .replace(/^[\^~>=<\s]*/, '');
if (!CLERK_JS_VERSION) {
  throw new Error('[vite] @clerk/clerk-js not found in package.json — __CLERK_JS_VERSION__ would be empty and 404 the Clerk Frontend API script URL.');
}
// @clerk/ui (the runtime UI controller, pinned by CLERK_UI_VERSION in
// src/services/clerk.ts) is major 1, which pairs with @clerk/clerk-js major 6.
// Fail the build if the SDK major drifts so the pairing is updated deliberately
// rather than loading an incompatible UI controller and breaking auth at runtime.
if (CLERK_JS_VERSION.split('.')[0] !== '6') {
  throw new Error(`[vite] @clerk/clerk-js major is ${CLERK_JS_VERSION.split('.')[0]}, expected 6 — update CLERK_UI_VERSION in src/services/clerk.ts to the paired @clerk/ui major, then bump this guard.`);
}

const PANEL_CHUNK_NAMES = [
  'panels-markets',
  'panels-energy',
  'panels-defense',
  'panels-news',
  'panels-economy',
  'panels-intel',
  'panels-risk',
] as const;
type PanelChunkName = typeof PANEL_CHUNK_NAMES[number];
const PANEL_SUPPORT_CHUNK_NAMES = ['panel-support'] as const;
type PanelSupportChunkName = typeof PANEL_SUPPORT_CHUNK_NAMES[number];
type PanelManualChunkName = PanelChunkName | PanelSupportChunkName;

// Single source of truth for chunk names that must NOT be hoisted into the
// entry HTML's modulepreload list. Used by both `manualChunks` (return values
// must literally match these strings) and `modulePreload.resolveDependencies`
// (filter regex is built from this list). Keeping them tied prevents the
// silent-breakage failure mode where renaming a chunk in `manualChunks`
// re-eagerises the WebGL stack without any build-time error.
//   - maplibre, deck-stack, protomaps: heavy WebGL deps, only reachable via MapContainer
//   - MapContainer: the dynamic-import target itself
//   - panels-*: panel domain chunks; keep them out of the entry HTML preload
//   - UnifiedSettings, settings-window, checkout: secondary interaction flows;
//     first paint only needs their header buttons and cheap event wiring
const LAZY_HTML_PRELOAD_CHUNKS = [
  'maplibre',
  'deck-stack',
  'protomaps',
  'h3-js',
  'MapContainer',
  'UnifiedSettings',
  'settings-window',
  'checkout',
  ...PANEL_CHUNK_NAMES,
  ...PANEL_SUPPORT_CHUNK_NAMES,
] as const;
const LAZY_HTML_PRELOAD_RE = new RegExp(
  `/(?:${LAZY_HTML_PRELOAD_CHUNKS.join('|')}|rpc-client-[A-Za-z0-9_-]+)-[A-Za-z0-9_-]+\\.js$`,
);

// Panel-cluster manualChunks map. Splits the previously monolithic ~2.3MB
// `panels` chunk into per-domain chunks so cache invalidation is local to
// the cluster a panel lives in and per-variant builds can prune unused
// clusters. New panel files must be assigned here before the build can split
// them; otherwise they would silently fall back into an eager catch-all chunk.
const PANEL_CLUSTER: Record<string, PanelChunkName> = {
  // Markets / equities / crypto positioning
  AAIISentiment: 'panels-markets', CotPositioning: 'panels-markets',
  ETFFlows: 'panels-markets', EarningsCalendar: 'panels-markets',
  EconomicCalendar: 'panels-markets', FearGreed: 'panels-markets',
  Fx: 'panels-markets',
  GoldIntelligence: 'panels-markets', LiquidityShifts: 'panels-markets',
  MacroSignals: 'panels-markets', Market: 'panels-markets',
  MarketBreadth: 'panels-markets', MarketImplications: 'panels-markets',
  NewsMarketCorrelation: 'panels-markets',
  NqCatalysts: 'panels-markets', NqPulse: 'panels-markets',
  Positioning: 'panels-markets', Stablecoin: 'panels-markets',
  StockAnalysis: 'panels-markets', StockBacktest: 'panels-markets',
  WsbTickerScanner: 'panels-markets', YieldCurve: 'panels-markets',
  // Energy / commodities / supply infra
  ChokepointStrip: 'panels-energy', EnergyComplex: 'panels-energy',
  EnergyCrisis: 'panels-energy', EnergyDisruptions: 'panels-energy',
  EnergyRiskOverview: 'panels-energy', FuelPrices: 'panels-energy',
  FuelShortage: 'panels-energy', Hormuz: 'panels-energy',
  OilInventories: 'panels-energy', PipelineStatus: 'panels-energy',
  StorageFacilityMap: 'panels-energy', RenewableEnergy: 'panels-energy',
  // Defense / military / aviation
  AirlineIntel: 'panels-defense', DefensePatents: 'panels-defense',
  OrefSirens: 'panels-defense', StrategicPosture: 'panels-defense',
  StrategicRisk: 'panels-defense', ThermalEscalation: 'panels-defense',
  UcdpEvents: 'panels-defense',
  // News / feeds / briefs
  BreakthroughsTicker: 'panels-news', ClimateNews: 'panels-news',
  DailyMarketBrief: 'panels-news', GdeltIntel: 'panels-news',
  GoodThingsDigest: 'panels-news', LatestBrief: 'panels-news',
  LiveNews: 'panels-news', News: 'panels-news',
  PositiveNewsFeed: 'panels-news', TelegramIntel: 'panels-news', XIntel: 'panels-news',
  // Macro / prices / trade
  BigMac: 'panels-economy', ConsumerPrices: 'panels-economy',
  Economic: 'panels-economy', GlobalProcurement: 'panels-economy',
  FaoFoodPriceIndex: 'panels-economy', FSI: 'panels-economy',
  GroceryBasket: 'panels-economy', GulfEconomies: 'panels-economy',
  Investments: 'panels-economy', MacroTiles: 'panels-economy',
  NationalDebt: 'panels-economy', SanctionsPressure: 'panels-economy',
  ChinaActivityNowcast: 'panels-economy', ChinaCorridor: 'panels-economy',
  SupplyChain: 'panels-economy',
  TradePolicy: 'panels-economy',
  // Country briefs / signals / monitors / agent surfaces.
  // CorrelationPanel base lives here, so all *Correlation consumers MUST stay
  // in this cluster — splitting them across clusters caused TDZ on init.
  ChatAnalyst: 'panels-intel', CII: 'panels-intel',
  Cascade: 'panels-intel', Correlation: 'panels-intel',
  CountryBrief: 'panels-intel', CountryBriefPage: 'panels-intel',
  CountryDeepDive: 'panels-intel',
  CrossSourceSignals: 'panels-intel', CustomWidget: 'panels-intel',
  Deduction: 'panels-intel',
  DisasterCorrelation: 'panels-intel',
  EconomicCorrelation: 'panels-intel',
  EscalationCorrelation: 'panels-intel',
  MilitaryCorrelation: 'panels-intel',
  Forecast: 'panels-intel',
  HeroSpotlight: 'panels-intel', Insights: 'panels-intel',
  LiveWebcams: 'panels-intel', McpData: 'panels-intel',
  Monitor: 'panels-intel', PinnedWebcams: 'panels-intel',
  Prediction: 'panels-intel', ProgressCharts: 'panels-intel',
  RegionalIntelligenceBoard: 'panels-intel',
  Regulation: 'panels-intel',
  // Disasters / climate / connectivity / society
  ClimateAnomaly: 'panels-risk', Counters: 'panels-risk',
  DiseaseOutbreaks: 'panels-risk',
  Displacement: 'panels-risk', GeoHubs: 'panels-risk',
  Giving: 'panels-risk', InternetDisruptions: 'panels-risk',
  PopulationExposure: 'panels-risk', RadiationWatch: 'panels-risk',
  RuntimeConfig: 'panels-risk', SatelliteFires: 'panels-risk',
  SecurityAdvisories: 'panels-risk', ServiceStatus: 'panels-risk',
  SocialVelocity: 'panels-risk', SpeciesComeback: 'panels-risk',
  TechEvents: 'panels-risk',
  ThreatTimeline: 'panels-risk',
  TechHubs: 'panels-risk', TechReadiness: 'panels-risk', TorontoSafety: 'panels-risk',
  WorldClock: 'panels-risk',
};

const PANEL_SUPPORT_CLUSTER: Record<string, PanelSupportChunkName> = {
  Status: 'panel-support',
};

function panelKeyForComponentId(id: string): string | null {
  if (!id.includes('/src/components/') || !id.endsWith('.ts')) return null;
  const match = id.match(/\/([^/]+)\.ts$/);
  if (!match) return null;
  const fileBase = match[1];
  if (fileBase === 'Panel') return null;
  if (fileBase === 'CountryBriefPage' || fileBase === 'RegionalIntelligenceBoard') return fileBase;
  if (fileBase.endsWith('Panel')) return fileBase.slice(0, -'Panel'.length);
  return null;
}

function panelChunkForComponentId(id: string): PanelManualChunkName | null {
  const panelKey = panelKeyForComponentId(id);
  if (!panelKey) return null;
  const chunkName = PANEL_SUPPORT_CLUSTER[panelKey] ?? PANEL_CLUSTER[panelKey];
  if (chunkName) return chunkName;
  throw new Error(`[manualChunks] Unassigned panel component ${panelKey}. Add it to PANEL_CLUSTER or PANEL_SUPPORT_CLUSTER in vite.config.ts.`);
}

function brotliPrecompressPlugin(): Plugin {
  return {
    name: 'brotli-precompress',
    apply: 'build',
    async writeBundle(outputOptions, bundle) {
      const outDir = outputOptions.dir;
      if (!outDir) return;

      await Promise.all(Object.keys(bundle).map(async (fileName) => {
        const extension = extname(fileName).toLowerCase();
        if (!BROTLI_EXTENSIONS.has(extension)) return;

        const sourcePath = resolve(outDir, fileName);
        const compressedPath = `${sourcePath}.br`;
        const sourceBuffer = await readFile(sourcePath);
        if (sourceBuffer.length < 1024) return;

        const compressedBuffer = await brotliCompressAsync(sourceBuffer);
        await mkdir(dirname(compressedPath), { recursive: true });
        await writeFile(compressedPath, compressedBuffer);
      }));
    },
  };
}

function htmlVariantPlugin(activeMeta: VariantMeta, activeVariant: string, isDesktopBuild: boolean): Plugin {
  return {
    name: 'html-variant',
    transformIndexHtml(html) {
      let result = html
        .replace(/<title>.*?<\/title>/, `<title>${activeMeta.title}</title>`)
        .replace(/<meta name="title" content=".*?" \/>/, `<meta name="title" content="${activeMeta.title}" />`)
        .replace(/<meta name="description" content=".*?" \/>/, `<meta name="description" content="${activeMeta.description}" />`)
        .replace(/<meta name="keywords" content=".*?" \/>/, `<meta name="keywords" content="${activeMeta.keywords}" />`)
        .replace(/<link rel="canonical" href=".*?" \/>/, `<link rel="canonical" href="${activeMeta.url}" />`)
        .replace(/<meta name="application-name" content=".*?" \/>/, `<meta name="application-name" content="${activeMeta.siteName}" />`)
        .replace(/<meta property="og:url" content=".*?" \/>/, `<meta property="og:url" content="${activeMeta.url}" />`)
        .replace(/<meta property="og:title" content=".*?" \/>/, `<meta property="og:title" content="${activeMeta.title}" />`)
        .replace(/<meta property="og:description" content=".*?" \/>/, `<meta property="og:description" content="${activeMeta.description}" />`)
        .replace(/<meta property="og:site_name" content=".*?" \/>/, `<meta property="og:site_name" content="${activeMeta.siteName}" />`)
        .replace(/<meta name="subject" content=".*?" \/>/, `<meta name="subject" content="${activeMeta.subject}" />`)
        .replace(/<meta name="classification" content=".*?" \/>/, `<meta name="classification" content="${activeMeta.classification}" />`)
        .replace(/<meta name="twitter:url" content=".*?" \/>/, `<meta name="twitter:url" content="${activeMeta.url}" />`)
        .replace(/<meta name="twitter:title" content=".*?" \/>/, `<meta name="twitter:title" content="${activeMeta.title}" />`)
        .replace(/<meta name="twitter:description" content=".*?" \/>/, `<meta name="twitter:description" content="${activeMeta.description}" />`)
        .replace(/"name": "World Monitor"/, `"name": "${activeMeta.siteName}"`)
        .replace(/"alternateName": "WorldMonitor"/, `"alternateName": "${activeMeta.siteName.replace(' ', '')}"`)
        .replace(/"url": "https:\/\/worldmonitor\.app\/"/, `"url": "${activeMeta.url}"`)
        .replace(/"description": "Real-time global intelligence dashboard with live news, markets, military tracking, infrastructure monitoring, and geopolitical data."/, `"description": "${activeMeta.description}"`)
        .replace(/"featureList": \[[\s\S]*?\]/, `"featureList": ${JSON.stringify(activeMeta.features, null, 8).replace(/\n/g, '\n      ')}`);

      // Theme-color meta — warm cream for happy variant
      if (activeVariant === 'happy') {
        result = result.replace(
          /<meta name="theme-color" content=".*?" \/>/,
          '<meta name="theme-color" content="#FAFAF5" />'
        );
      }

      // Desktop builds: inject build-time variant into the inline script so data-variant is set
      // before CSS loads. Web builds always use 'full' — runtime hostname detection handles variants.
      if (activeVariant !== 'full') {
        result = result.replace(
          /if\(v\)document\.documentElement\.dataset\.variant=v;/,
          `v='${activeVariant}';document.documentElement.dataset.variant=v;`
        );
      }

      // Desktop CSP: inject localhost wildcard for dynamic sidecar port.
      // Web builds intentionally exclude localhost to avoid exposing attack surface.
      if (isDesktopBuild) {
        result = result
          .replace(
            /connect-src 'self' https: http:\/\/localhost:5173/,
            "connect-src 'self' https: http://localhost:5173 http://127.0.0.1:*"
          )
          .replace(
            /frame-src 'self'/,
            "frame-src 'self' http://127.0.0.1:*"
          );
      }

      // Desktop builds: replace favicon paths with variant-specific subdirectory.
      // Web builds use 'full' favicons in HTML; runtime JS swaps them per hostname.
      if (activeVariant !== 'full') {
        result = result
          .replace(/\/favico\/favicon/g, `/favico/${activeVariant}/favicon`)
          .replace(/\/favico\/apple-touch-icon/g, `/favico/${activeVariant}/apple-touch-icon`)
          .replace(/\/favico\/android-chrome/g, `/favico/${activeVariant}/android-chrome`)
          .replace(/\/favico\/og-image/g, `/favico/${activeVariant}/og-image`);
      }

      return result;
    },
  };
}

function dashboardHtmlOutputPlugin(): Plugin {
  return {
    name: 'wm-dashboard-html-output',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const dashboardEntry = Object.entries(bundle).find(([, output]) =>
        output.type === 'asset' && output.fileName === 'index.html'
      );
      if (!dashboardEntry) {
        throw new Error('[vite] expected dashboard HTML entry index.html before renaming it to dashboard.html');
      }

      const [bundleKey, dashboardHtml] = dashboardEntry;
      delete bundle[bundleKey];
      dashboardHtml.fileName = 'dashboard.html';
      if (typeof dashboardHtml.source === 'string') {
        dashboardHtml.source = deferDashboardStylesheetLinks(dashboardHtml.source, bundle);
      }
      bundle['dashboard.html'] = dashboardHtml;
    },
  };
}

function chunkSizeWarningPolicyPlugin(): Plugin {
  return {
    name: 'wm-chunk-size-warning-policy',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        const warning = getChunkSizeWarning({
          name: output.name,
          fileName: output.fileName,
          sizeBytes: Buffer.byteLength(output.code),
        });
        if (warning) this.warn(warning);
      }
    },
  };
}

// Emit dashboard-<variant>.html siblings of dashboard.html for the variant
// subdomains (#4996). The web deployment serves the 'full' build to every
// host, so tech/finance/commodity/happy/energy.worldmonitor.app/dashboard
// shipped full-brand meta and a cross-host canonical pointing at www —
// crawlers saw five duplicate pages that all declared themselves NOT to be
// the sitemap URL they were fetched from. vercel.json host-based rewrites
// map each variant host's /dashboard to its generated file. Runs in
// generateBundle AFTER dashboardHtmlOutputPlugin (both enforce: 'post',
// registered later in the plugins array) so it reads the final renamed +
// stylesheet-deferred dashboard.html; emitted via emitFile so
// brotliPrecompressPlugin picks the files up like any other asset.
function variantDashboardHtmlPlugin(): Plugin {
  return {
    name: 'wm-variant-dashboard-html',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const dashboard = bundle['dashboard.html'];
      if (!dashboard || dashboard.type !== 'asset' || typeof dashboard.source !== 'string') {
        throw new Error('[vite] wm-variant-dashboard-html expected dashboard.html asset (must run after wm-dashboard-html-output)');
      }
      for (const variant of WEB_DASHBOARD_VARIANTS) {
        this.emitFile({
          type: 'asset',
          fileName: variantDashboardFileName(variant),
          source: renderVariantDashboardHtml(dashboard.source, variant),
        });
      }
    },
  };
}

function shouldDeferDashboardStylesheet(tag: string, bundle: OutputBundle): boolean {
  const href = tag.match(/\bhref=["']([^"']+\.css)["']/i)?.[1];
  if (!href) return false;

  const bundleKey = href.replace(/^\//, '');
  const asset = bundle[bundleKey];
  if (!asset || asset.type !== 'asset') return false;

  const sourceLength = typeof asset.source === 'string'
    ? Buffer.byteLength(asset.source)
    : asset.source.byteLength;
  return sourceLength >= 100 * 1024;
}

// Rewrite large render-blocking dashboard <link rel=stylesheet> tags into a
// deferred form (media="print" + data-wm-deferred-style="dashboard") plus a
// <noscript> copy of the original blocking link, so the ~492KB app CSS no
// longer blocks first paint. src/main.ts activateDeferredDashboardStyles()
// flips media -> "all" at startup; the attribute name + values written here MUST
// stay in lockstep with that runtime selector. Only assets >=100KB are deferred
// (shouldDeferDashboardStylesheet) so small stylesheets stay blocking; links
// that already set media= (an intentionally print/screen-scoped sheet) or are
// already deferred are skipped. NOTE: during the defer window only the UNLAYERED
// inline critical CSS in index.html applies (the bundle is @layer base), so any
// future *unconditional* inline rule will beat the bundle (see PR #4346) — keep
// inline rules scoped to a transient/closed state.
function deferDashboardStylesheetLinks(html: string, bundle: OutputBundle): string {
  return html.replace(/<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["'][^"']+\.css["'])[^>]*>/gi, (tag) => {
    if (/\bdata-wm-deferred-style=/.test(tag) || /\bmedia=/.test(tag)) return tag;
    if (!shouldDeferDashboardStylesheet(tag, bundle)) return tag;
    const deferredTag = tag.replace(/\s*\/?>$/, ' media="print" data-wm-deferred-style="dashboard">');
    return `${deferredTag}\n    <noscript>${tag}</noscript>`;
  });
}

function polymarketPlugin(): Plugin {
  const GAMMA_BASE = 'https://gamma-api.polymarket.com';
  const ALLOWED_ORDER = ['volume', 'liquidity', 'startDate', 'endDate', 'spread'];

  return {
    name: 'polymarket-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/polymarket')) return next();

        const url = new URL(req.url, 'http://localhost');
        const endpoint = url.searchParams.get('endpoint') || 'markets';
        const closed = ['true', 'false'].includes(url.searchParams.get('closed') ?? '') ? url.searchParams.get('closed') : 'false';
        const order = ALLOWED_ORDER.includes(url.searchParams.get('order') ?? '') ? url.searchParams.get('order') : 'volume';
        const ascending = ['true', 'false'].includes(url.searchParams.get('ascending') ?? '') ? url.searchParams.get('ascending') : 'false';
        const rawLimit = parseInt(url.searchParams.get('limit') ?? '', 10);
        const limit = isNaN(rawLimit) ? 50 : Math.max(1, Math.min(100, rawLimit));

        const params = new URLSearchParams({ closed: closed!, order: order!, ascending: ascending!, limit: String(limit) });
        if (endpoint === 'events') {
          const tag = (url.searchParams.get('tag') ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 100);
          if (tag) params.set('tag_slug', tag);
        }

        const gammaUrl = `${GAMMA_BASE}/${endpoint === 'events' ? 'events' : 'markets'}?${params}`;

        res.setHeader('Content-Type', 'application/json');
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          const resp = await fetch(gammaUrl, { headers: { Accept: 'application/json' }, signal: controller.signal });
          clearTimeout(timer);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.text();
          res.setHeader('Cache-Control', 'public, max-age=120');
          res.setHeader('X-Polymarket-Source', 'gamma');
          res.end(data);
        } catch {
          // Expected: Cloudflare JA3 blocks server-side TLS — return empty array
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.end('[]');
        }
      });
    },
  };
}

/**
 * Vite dev server plugin for sebuf API routes.
 *
 * Intercepts requests matching /api/{domain}/v1/* and routes them through
 * the same handler pipeline as the Vercel catch-all gateway. Other /api/*
 * paths fall through to existing proxy rules.
 */
function sebufApiPlugin(): Plugin {
  // Cache router across requests (H-13 fix). Invalidated by Vite's module graph on HMR.
  let cachedRouter: Awaited<ReturnType<typeof buildRouter>> | null = null;
  let cachedCorsMod: any = null;

  async function buildRouter() {
    const [
      routerMod, corsMod, errorMod,
      seismologyServerMod, seismologyHandlerMod,
      wildfireServerMod, wildfireHandlerMod,
      climateServerMod, climateHandlerMod,
      predictionServerMod, predictionHandlerMod,
      displacementServerMod, displacementHandlerMod,
      aviationServerMod, aviationHandlerMod,
      researchServerMod, researchHandlerMod,
      unrestServerMod, unrestHandlerMod,
      conflictServerMod, conflictHandlerMod,
      maritimeServerMod, maritimeHandlerMod,
      cyberServerMod, cyberHandlerMod,
      economicServerMod, economicHandlerMod,
      infrastructureServerMod, infrastructureHandlerMod,
      marketServerMod, marketHandlerMod,
      newsServerMod, newsHandlerMod,
      intelligenceServerMod, intelligenceHandlerMod,
      militaryServerMod, militaryHandlerMod,
      positiveEventsServerMod, positiveEventsHandlerMod,
      givingServerMod, givingHandlerMod,
      tradeServerMod, tradeHandlerMod,
      supplyChainServerMod, supplyChainHandlerMod,
      naturalServerMod, naturalHandlerMod,
      resilienceServerMod, resilienceHandlerMod,
      leadsServerMod, leadsHandlerMod,
      scenarioServerMod, scenarioHandlerMod,
      shippingV2ServerMod, shippingV2HandlerMod,
    ] = await Promise.all([
        import('./server/router'),
        import('./server/cors'),
        import('./server/error-mapper'),
        import('./src/generated/server/worldmonitor/seismology/v1/service_server'),
        import('./server/worldmonitor/seismology/v1/handler'),
        import('./src/generated/server/worldmonitor/wildfire/v1/service_server'),
        import('./server/worldmonitor/wildfire/v1/handler'),
        import('./src/generated/server/worldmonitor/climate/v1/service_server'),
        import('./server/worldmonitor/climate/v1/handler'),
        import('./src/generated/server/worldmonitor/prediction/v1/service_server'),
        import('./server/worldmonitor/prediction/v1/handler'),
        import('./src/generated/server/worldmonitor/displacement/v1/service_server'),
        import('./server/worldmonitor/displacement/v1/handler'),
        import('./src/generated/server/worldmonitor/aviation/v1/service_server'),
        import('./server/worldmonitor/aviation/v1/handler'),
        import('./src/generated/server/worldmonitor/research/v1/service_server'),
        import('./server/worldmonitor/research/v1/handler'),
        import('./src/generated/server/worldmonitor/unrest/v1/service_server'),
        import('./server/worldmonitor/unrest/v1/handler'),
        import('./src/generated/server/worldmonitor/conflict/v1/service_server'),
        import('./server/worldmonitor/conflict/v1/handler'),
        import('./src/generated/server/worldmonitor/maritime/v1/service_server'),
        import('./server/worldmonitor/maritime/v1/handler'),
        import('./src/generated/server/worldmonitor/cyber/v1/service_server'),
        import('./server/worldmonitor/cyber/v1/handler'),
        import('./src/generated/server/worldmonitor/economic/v1/service_server'),
        import('./server/worldmonitor/economic/v1/handler'),
        import('./src/generated/server/worldmonitor/infrastructure/v1/service_server'),
        import('./server/worldmonitor/infrastructure/v1/handler'),
        import('./src/generated/server/worldmonitor/market/v1/service_server'),
        import('./server/worldmonitor/market/v1/handler'),
        import('./src/generated/server/worldmonitor/news/v1/service_server'),
        import('./server/worldmonitor/news/v1/handler'),
        import('./src/generated/server/worldmonitor/intelligence/v1/service_server'),
        import('./server/worldmonitor/intelligence/v1/handler'),
        import('./src/generated/server/worldmonitor/military/v1/service_server'),
        import('./server/worldmonitor/military/v1/handler'),
        import('./src/generated/server/worldmonitor/positive_events/v1/service_server'),
        import('./server/worldmonitor/positive-events/v1/handler'),
        import('./src/generated/server/worldmonitor/giving/v1/service_server'),
        import('./server/worldmonitor/giving/v1/handler'),
        import('./src/generated/server/worldmonitor/trade/v1/service_server'),
        import('./server/worldmonitor/trade/v1/handler'),
        import('./src/generated/server/worldmonitor/supply_chain/v1/service_server'),
        import('./server/worldmonitor/supply-chain/v1/handler'),
        import('./src/generated/server/worldmonitor/natural/v1/service_server'),
        import('./server/worldmonitor/natural/v1/handler'),
        import('./src/generated/server/worldmonitor/resilience/v1/service_server'),
        import('./server/worldmonitor/resilience/v1/handler'),
        import('./src/generated/server/worldmonitor/leads/v1/service_server'),
        import('./server/worldmonitor/leads/v1/handler'),
        import('./src/generated/server/worldmonitor/scenario/v1/service_server'),
        import('./server/worldmonitor/scenario/v1/handler'),
        import('./src/generated/server/worldmonitor/shipping/v2/service_server'),
        import('./server/worldmonitor/shipping/v2/handler'),
      ]);

    const serverOptions = {
      onError: errorMod.mapErrorToResponse,
      validateRequest: validateGeneratedRequest,
    };
    const allRoutes = [
      ...seismologyServerMod.createSeismologyServiceRoutes(seismologyHandlerMod.seismologyHandler, serverOptions),
      ...wildfireServerMod.createWildfireServiceRoutes(wildfireHandlerMod.wildfireHandler, serverOptions),
      ...climateServerMod.createClimateServiceRoutes(climateHandlerMod.climateHandler, serverOptions),
      ...predictionServerMod.createPredictionServiceRoutes(predictionHandlerMod.predictionHandler, serverOptions),
      ...displacementServerMod.createDisplacementServiceRoutes(displacementHandlerMod.displacementHandler, serverOptions),
      ...aviationServerMod.createAviationServiceRoutes(aviationHandlerMod.aviationHandler, serverOptions),
      ...researchServerMod.createResearchServiceRoutes(researchHandlerMod.researchHandler, serverOptions),
      ...unrestServerMod.createUnrestServiceRoutes(unrestHandlerMod.unrestHandler, serverOptions),
      ...conflictServerMod.createConflictServiceRoutes(conflictHandlerMod.conflictHandler, serverOptions),
      ...maritimeServerMod.createMaritimeServiceRoutes(maritimeHandlerMod.maritimeHandler, serverOptions),
      ...cyberServerMod.createCyberServiceRoutes(cyberHandlerMod.cyberHandler, serverOptions),
      ...economicServerMod.createEconomicServiceRoutes(economicHandlerMod.economicHandler, serverOptions),
      ...infrastructureServerMod.createInfrastructureServiceRoutes(infrastructureHandlerMod.infrastructureHandler, serverOptions),
      ...marketServerMod.createMarketServiceRoutes(marketHandlerMod.marketHandler, serverOptions),
      ...newsServerMod.createNewsServiceRoutes(newsHandlerMod.newsHandler, serverOptions),
      ...intelligenceServerMod.createIntelligenceServiceRoutes(intelligenceHandlerMod.intelligenceHandler, serverOptions),
      ...militaryServerMod.createMilitaryServiceRoutes(militaryHandlerMod.militaryHandler, serverOptions),
      ...positiveEventsServerMod.createPositiveEventsServiceRoutes(positiveEventsHandlerMod.positiveEventsHandler, serverOptions),
      ...givingServerMod.createGivingServiceRoutes(givingHandlerMod.givingHandler, serverOptions),
      ...tradeServerMod.createTradeServiceRoutes(tradeHandlerMod.tradeHandler, serverOptions),
      ...supplyChainServerMod.createSupplyChainServiceRoutes(supplyChainHandlerMod.supplyChainHandler, serverOptions),
      ...naturalServerMod.createNaturalServiceRoutes(naturalHandlerMod.naturalHandler, serverOptions),
      ...resilienceServerMod.createResilienceServiceRoutes(resilienceHandlerMod.resilienceHandler, serverOptions),
      ...leadsServerMod.createLeadsServiceRoutes(leadsHandlerMod.leadsHandler, serverOptions),
      ...scenarioServerMod.createScenarioServiceRoutes(scenarioHandlerMod.scenarioHandler, serverOptions),
      ...shippingV2ServerMod.createShippingV2ServiceRoutes(shippingV2HandlerMod.shippingV2Handler, serverOptions),
    ];
    cachedCorsMod = corsMod;
    return routerMod.createRouter(allRoutes);
  }

  return {
    name: 'sebuf-api',
    configureServer(server) {
      // Invalidate cached router on HMR updates to server/ files
      server.watcher.on('change', (file) => {
        if (file.includes('/server/') || file.includes('/src/generated/server/')) {
          cachedRouter = null;
        }
      });

      // Legacy v1 URL aliases → new sebuf RPC paths (mirror of the alias files
      // in api/scenario/v1/ + api/supply-chain/v1/). Vercel serves the alias
      // files directly; vite dev has no file-based routing for api/, so we
      // rewrite the pathname here before the router lookup.
      const V1_ALIASES: Record<string, string> = {
        '/api/scenario/v1/run': '/api/scenario/v1/run-scenario',
        '/api/scenario/v1/status': '/api/scenario/v1/get-scenario-status',
        '/api/scenario/v1/templates': '/api/scenario/v1/list-scenario-templates',
        '/api/supply-chain/v1/country-products': '/api/supply-chain/v1/get-country-products',
        '/api/supply-chain/v1/multi-sector-cost-shock': '/api/supply-chain/v1/get-multi-sector-cost-shock',
      };

      server.middlewares.use(async (req, res, next) => {
        // Intercept sebuf routes in two forms:
        //  - standard /api/{domain}/v{N}/* (domain-first, e.g. /api/market/v1/...)
        //  - partner-URL-preservation /api/v{N}/{domain}/* (version-first, e.g.
        //    /api/v2/shipping/...). Only the second form applies when the
        //    external contract already uses a reversed layout.
        if (!req.url || !/^\/api\/(?:[a-z][a-z0-9-]*\/v\d+|v\d+\/[a-z][a-z0-9-]*)\//.test(req.url)) {
          return next();
        }

        // Rewrite documented v1 URL → new sebuf path if this is an alias.
        const [pathOnly, queryOnly] = req.url.split('?', 2);
        const aliasTarget = pathOnly ? V1_ALIASES[pathOnly] : undefined;
        if (aliasTarget) {
          req.url = queryOnly ? `${aliasTarget}?${queryOnly}` : aliasTarget;
        }

        try {
          // Build router once, reuse across requests (H-13 fix)
          if (!cachedRouter) {
            cachedRouter = await buildRouter();
          }
          const router = cachedRouter;
          const corsMod = cachedCorsMod;

          // Convert Connect IncomingMessage to Web Standard Request
          const port = server.config.server.port || 3000;
          const url = new URL(req.url, `http://localhost:${port}`);

          // Read body for POST requests
          let body: string | undefined;
          if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            }
            body = Buffer.concat(chunks).toString();
          }

          // Extract headers from IncomingMessage
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') {
              headers[key] = value;
            } else if (Array.isArray(value)) {
              headers[key] = value.join(', ');
            }
          }

          const webRequest = new Request(url.toString(), {
            method: req.method,
            headers,
            body: body || undefined,
          });

          const corsHeaders = corsMod.getCorsHeaders(webRequest);

          // OPTIONS preflight
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            for (const [key, value] of Object.entries(corsHeaders)) {
              res.setHeader(key, value);
            }
            res.end();
            return;
          }

          // Origin check
          if (corsMod.isDisallowedOrigin(webRequest)) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            for (const [key, value] of Object.entries(corsHeaders)) {
              res.setHeader(key, value);
            }
            res.end(JSON.stringify({ error: 'Origin not allowed' }));
            return;
          }

          // Route matching
          const matchedHandler = router.match(webRequest);
          if (!matchedHandler) {
            const allowed = router.allowedMethods(new URL(webRequest.url).pathname);
            if (allowed.length > 0) {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Allow', allowed.join(', '));
            } else {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
            }
            for (const [key, value] of Object.entries(corsHeaders)) {
              res.setHeader(key, value);
            }
            res.end(JSON.stringify({ error: res.statusCode === 405 ? 'Method not allowed' : 'Not found' }));
            return;
          }

          // Execute handler
          const response = await matchedHandler(webRequest);

          // Write response. HEAD is GET without a payload (#7275).
          res.statusCode = response.status;
          response.headers.forEach((value, key) => {
            res.setHeader(key, value);
          });
          for (const [key, value] of Object.entries(corsHeaders)) {
            res.setHeader(key, value);
          }
          if (req.method === 'HEAD') {
            if (response.body) {
              try { void response.body.cancel(); } catch { /* already consumed */ }
            }
            res.end();
            return;
          }
          res.end(await response.text());
        } catch (err) {
          console.error('[sebuf-api] Error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    },
  };
}

function rssProxyPlugin(): Plugin {
  return {
    name: 'rss-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/rss-proxy')) {
          return next();
        }

        const url = new URL(req.url, 'http://localhost');
        const feedUrl = url.searchParams.get('url');
        if (!feedUrl) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing url parameter' }));
          return;
        }

        try {
          const parsed = new URL(feedUrl);
          if (!isAllowedDomain(parsed.hostname)) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `Domain not allowed: ${parsed.hostname}` }));
            return;
          }

          const controller = new AbortController();
          const timeout = feedUrl.includes('news.google.com') ? 20000 : 12000;
          const timer = setTimeout(() => controller.abort(), timeout);

          const response = await fetch(feedUrl, {
            signal: controller.signal,
            headers: rssFetchHeadersForHost(parsed.hostname),
            redirect: 'follow',
          });
          clearTimeout(timer);

          const data = await response.text();
          res.statusCode = response.status;
          res.setHeader('Content-Type', 'application/xml');
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(data);
        } catch (error: any) {
          console.error('[rss-proxy]', feedUrl, error.message);
          res.statusCode = error.name === 'AbortError' ? 504 : 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: error.name === 'AbortError' ? 'Feed timeout' : 'Failed to fetch feed' }));
        }
      });
    },
  };
}

function youtubeLivePlugin(): Plugin {
  return {
    name: 'youtube-live',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/youtube/live')) {
          return next();
        }

        const url = new URL(req.url, 'http://localhost');
        const channel = url.searchParams.get('channel');

        if (!channel) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing channel parameter' }));
          return;
        }

        try {
          const channelHandle = channel.startsWith('@') ? channel : `@${channel}`;
          const liveUrl = `https://www.youtube.com/${channelHandle}/live`;

          const ytRes = await fetch(liveUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            redirect: 'follow',
          });

          if (!ytRes.ok) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'public, max-age=300');
            res.end(JSON.stringify({ videoId: null, channel }));
            return;
          }

          const html = await ytRes.text();

          // Scope both fields to the same videoDetails block so we don't
          // combine a videoId from one object with isLive from another.
          let videoId: string | null = null;
          const detailsIdx = html.indexOf('"videoDetails"');
          if (detailsIdx !== -1) {
            const block = html.substring(detailsIdx, detailsIdx + 5000);
            const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
            const liveMatch = block.match(/"isLive"\s*:\s*true/);
            if (vidMatch && liveMatch) {
              videoId = vidMatch[1];
            }
          }

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.end(JSON.stringify({ videoId, isLive: videoId !== null, channel }));
        } catch (error) {
          console.error(`[YouTube Live] Error:`, error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Failed to fetch', videoId: null }));
        }
      });
    },
  };
}

function gpsjamDevPlugin(): Plugin {
  return {
    name: 'gpsjam-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/api/gpsjam' && !req.url?.startsWith('/api/gpsjam?')) {
          return next();
        }

        try {
          const data = await readFile(resolve(__dirname, 'scripts/data/gpsjam-latest.json'), 'utf8');
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(data);
        } catch {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(JSON.stringify({ error: 'No GPS jam data. Run: node scripts/fetch-gpsjam.mjs' }));
        }
      });
    },
  };
}

// Mirror the WebMCP security gates during local development. Chrome's
// #enable-webmcp-testing flag bypasses origin-trial enrollment, but it does not
// bypass origin isolation or Permissions Policy. Keeping these headers in the
// dev server makes the documented local smoke meaningful while preserving the
// production boundary: no Origin-Trial token is ever served locally.
function webMcpDevSecurityHeadersPlugin(): Plugin {
  return {
    name: 'wm-webmcp-dev-security-headers',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const isEmbedDocument = pathname === '/embed' || pathname === '/embed.html';
        res.setHeader('Origin-Agent-Cluster', '?1');
        res.setHeader('Permissions-Policy', isEmbedDocument ? 'tools=()' : 'tools=(self)');
        next();
      });
    },
  };
}

// Dev-only endpoint for the voice agent: mints ephemeral OpenAI Realtime
// client secrets so the browser never sees the real key. Production is served
// by api/realtime-token.js on Vercel; vite has no file-based api/ routing, so
// this middleware mirrors it for `npm run dev`.
function realtimeTokenPlugin(): Plugin {
  return {
    name: 'realtime-token',
    configureServer(server) {
      server.middlewares.use('/api/realtime-token', async (req, res) => {
        const json = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'GET' && req.method !== 'POST') {
          return json(405, { error: 'Method not allowed' });
        }
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          return json(200, { error: 'OPENAI_API_KEY is not set — add it to .env.local and restart the dev server' });
        }
        const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1-mini';
        const voice = process.env.OPENAI_REALTIME_VOICE || 'cedar';
        try {
          const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session: {
                type: 'realtime',
                model,
                audio: {
                  input: {
                    noise_reduction: { type: 'near_field' },
                    turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true },
                  },
                  output: { voice },
                },
              },
            }),
          });
          const body = await response.text();
          res.statusCode = response.status;
          res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Voice-Model', model);
          res.end(body);
        } catch (error) {
          json(502, { error: error instanceof Error ? error.message : 'Failed to mint Realtime token' });
        }
      });
    },
  };
}

// Dev-only OpenSky proxy for the voice agent's whole-sky area scans.
// Authenticates with OPENSKY_CLIENT_ID/SECRET (OAuth client-credentials) when
// present — anonymous otherwise — and passes bbox params through to /states/all.
function openskyPlugin(): Plugin {
  let cachedToken: { value: string; expiresAt: number } | null = null;

  async function getAccessToken(): Promise<string | null> {
    const id = process.env.OPENSKY_CLIENT_ID;
    const secret = process.env.OPENSKY_CLIENT_SECRET;
    if (!id || !secret) return null;
    if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value;
    const res = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
    });
    if (!res.ok) return null;
    const body = await res.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) return null;
    cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 1800) * 1000 };
    return cachedToken.value;
  }

  return {
    name: 'opensky-proxy',
    configureServer(server) {
      server.middlewares.use('/api/opensky', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const url = new URL(req.url || '', 'http://localhost');
          const upstream = new URL('https://opensky-network.org/api/states/all');
          for (const key of ['lamin', 'lamax', 'lomin', 'lomax']) {
            const v = url.searchParams.get(key);
            if (v !== null) upstream.searchParams.set(key, v);
          }
          const token = await getAccessToken();
          const headers: Record<string, string> = { Accept: 'application/json' };
          if (token) headers.Authorization = `Bearer ${token}`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15_000);
          const upstreamRes = await fetch(upstream, { headers, signal: controller.signal });
          clearTimeout(timer);
          res.statusCode = upstreamRes.status;
          res.end(await upstreamRes.text());
        } catch (error) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'OpenSky request failed' }));
        }
      });
    },
  };
}

// Dev-only free route lookup for the voice agent: callsign → origin/destination
// airports via adsbdb.com (no key, CORS-proxied here). Session-cached; adsbdb
// asks for gentle use so misses are cached too.
function routeLookupPlugin(): Plugin {
  const cache = new Map<string, { body: string; expiresAt: number }>();
  const TTL = 30 * 60_000;
  return {
    name: 'route-lookup',
    configureServer(server) {
      server.middlewares.use('/api/route-lookup', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const url = new URL(req.url || '', 'http://localhost');
          const callsign = (url.searchParams.get('callsign') || '').trim().toUpperCase();
          if (!callsign || !/^[A-Z0-9]{2,8}$/.test(callsign)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'invalid callsign' }));
            return;
          }
          const hit = cache.get(callsign);
          if (hit && hit.expiresAt > performance.now()) {
            res.end(hit.body);
            return;
          }
          let origin: string | null = null;
          let destination: string | null = null;
          try {
            const r = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, {
              signal: AbortSignal.timeout(8_000),
            });
            if (r.ok) {
              const d = await r.json() as { response?: { flightroute?: { origin?: { iata_code?: string; name?: string; municipality?: string }; destination?: { iata_code?: string; name?: string; municipality?: string } } } };
              const fr = d.response?.flightroute;
              if (fr?.origin) origin = fr.origin.iata_code ? `${fr.origin.iata_code} (${fr.origin.municipality || fr.origin.name || ''})`.trim() : null;
              if (fr?.destination) destination = fr.destination.iata_code ? `${fr.destination.iata_code} (${fr.destination.municipality || fr.destination.name || ''})`.trim() : null;
            }
          } catch { /* leave nulls */ }
          const body = JSON.stringify({ callsign, origin, destination });
          cache.set(callsign, { body, expiresAt: performance.now() + TTL });
          res.end(body);
        } catch (error) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'route lookup failed' }));
        }
      });
    },
  };
}

// Dev-only adsb.lol proxy for the voice agent — free, no-key ADS-B with
// aircraft type + registration. Takes a bbox, queries adsb.lol by radius, and
// returns the rich records the agent needs (positions, type, tail number).
function adsbLolPlugin(): Plugin {
  return {
    name: 'adsblol',
    configureServer(server) {
      server.middlewares.use('/api/adsblol', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const url = new URL(req.url || '', 'http://localhost');
          const swLat = Number(url.searchParams.get('lamin'));
          const neLat = Number(url.searchParams.get('lamax'));
          const swLon = Number(url.searchParams.get('lomin'));
          const neLon = Number(url.searchParams.get('lomax'));
          if ([swLat, neLat, swLon, neLon].some((v) => !Number.isFinite(v))) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'lamin/lamax/lomin/lomax required' }));
            return;
          }
          const lat = (swLat + neLat) / 2;
          const lon = (swLon + neLon) / 2;
          const midRad = (lat * Math.PI) / 180;
          const halfDiagKm = 0.5 * Math.hypot(Math.abs(neLat - swLat) * 111, Math.abs(neLon - swLon) * 111 * Math.cos(midRad));
          const nm = Math.min(250, Math.max(10, Math.round(halfDiagKm / 1.852)));
          const upstream = await fetch(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}`, {
            // adsb.lol 403s requests without a descriptive User-Agent.
            headers: { Accept: 'application/json', 'User-Agent': 'worldmonitor-selfhost/1.0' },
            signal: AbortSignal.timeout(10_000),
          });
          if (!upstream.ok) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: `adsb.lol HTTP ${upstream.status}`, ac: [] }));
            return;
          }
          res.end(await upstream.text());
        } catch (error) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'adsb.lol failed', ac: [] }));
        }
      });
    },
  };
}

// Dev-only ISS TLE proxy — fetches the ISS orbital elements from CelesTrak
// (CORS-safe, cached 30 min) so the voice agent can predict overhead passes.
function issTlePlugin(): Plugin {
  let cache: { body: string; expiresAt: number } | null = null;
  return {
    name: 'iss-tle',
    configureServer(server) {
      server.middlewares.use('/api/iss-tle', async (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          if (cache && cache.expiresAt > performance.now()) {
            res.end(cache.body);
            return;
          }
          const r = await fetch('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE', {
            headers: { 'User-Agent': 'worldmonitor-selfhost/1.0' },
            signal: AbortSignal.timeout(8_000),
          });
          if (!r.ok) throw new Error(`CelesTrak HTTP ${r.status}`);
          const text = (await r.text()).trim();
          const [name, line1, line2] = text.split('\n').map((l) => l.trim());
          if (!line1 || !line2) throw new Error('malformed TLE');
          const body = JSON.stringify({ name, line1, line2 });
          cache = { body, expiresAt: performance.now() + 30 * 60_000 };
          res.end(body);
        } catch (error) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'ISS TLE fetch failed' }));
        }
      });
    },
  };
}

// Dev-only public traffic-camera catalog. Fetches Caltrans (CA DOT) districts
// + TfL London JamCams, normalizes to a common record with a live snapshot
// URL, caches the full catalog 15 min, and returns cameras inside a bbox.
interface TrafficCam { id: string; title: string; lat: number; lon: number; image: string; video: string | null; provider: string; }

function trafficCamsPlugin(): Plugin {
  let catalog: TrafficCam[] = [];
  let builtAt = 0;
  const TTL = 15 * 60_000;
  const CALTRANS_DISTRICTS = ['3', '4', '7', '11']; // Sacramento, Bay Area, LA, San Diego

  async function fetchCaltrans(): Promise<TrafficCam[]> {
    const out: TrafficCam[] = [];
    await Promise.all(CALTRANS_DISTRICTS.map(async (d) => {
      try {
        const dd = d.padStart(2, '0');
        const r = await fetch(`https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${dd}.json`, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return;
        const data = await r.json() as { data?: Array<{ cctv?: { index?: string; location?: { locationName?: string; latitude?: string; longitude?: string }; imageData?: { static?: { currentImageURL?: string }; streamingVideoURL?: string } } }> };
        for (const item of data.data ?? []) {
          const c = item.cctv;
          const lat = Number(c?.location?.latitude);
          const lon = Number(c?.location?.longitude);
          const image = c?.imageData?.static?.currentImageURL;
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || !image || lat === 0) continue;
          out.push({
            id: `caltrans-d${d}-${c?.index ?? out.length}`,
            title: c?.location?.locationName?.trim() || 'Caltrans camera',
            lat, lon, image,
            video: c?.imageData?.streamingVideoURL || null,
            provider: 'Caltrans',
          });
        }
      } catch { /* skip district */ }
    }));
    return out;
  }

  async function fetchTfl(): Promise<TrafficCam[]> {
    try {
      const r = await fetch('https://api.tfl.gov.uk/Place/Type/JamCam', { signal: AbortSignal.timeout(12_000) });
      if (!r.ok) return [];
      const data = await r.json() as Array<{ id?: string; commonName?: string; lat?: number; lon?: number; additionalProperties?: Array<{ key?: string; value?: string }> }>;
      return data.map((c) => {
        const props = Object.fromEntries((c.additionalProperties ?? []).map((p) => [p.key, p.value]));
        const image = props.imageUrl;
        if (typeof c.lat !== 'number' || typeof c.lon !== 'number' || !image) return null;
        return {
          id: `tfl-${c.id ?? ''}`,
          title: c.commonName || 'London JamCam',
          lat: c.lat, lon: c.lon, image,
          video: props.videoUrl || null,
          provider: 'TfL London',
        } as TrafficCam;
      }).filter((x): x is TrafficCam => x !== null);
    } catch { return []; }
  }

  async function fetchFlorida(): Promise<TrafficCam[]> {
    // Florida DOT (FL511): ~4,950 cameras. The map feed gives location +
    // itemId; the live JPEG snapshot is at /map/Cctv/{itemId} (CORS-open,
    // refreshed ~every 15-30s). HLS video needs a session token, so we use the
    // snapshot (the viewer auto-refreshes it).
    try {
      const r = await fetch('https://fl511.com/map/mapIcons/Cameras', {
        headers: { 'User-Agent': 'worldmonitor-selfhost/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return [];
      const data = await r.json() as { item2?: Array<{ itemId?: string; location?: [number, number]; expando?: { videoEnabled?: boolean } }> };
      const out: TrafficCam[] = [];
      for (const c of data.item2 ?? []) {
        const loc = c.location;
        if (!c.itemId || !loc || typeof loc[0] !== 'number' || typeof loc[1] !== 'number') continue;
        out.push({
          id: `fl511-${c.itemId}`,
          title: 'Florida DOT camera',
          lat: loc[0], lon: loc[1],
          image: `https://fl511.com/map/Cctv/${encodeURIComponent(c.itemId)}`,
          video: null,
          provider: 'Florida DOT',
        });
      }
      return out;
    } catch { return []; }
  }

  async function ensureCatalog(): Promise<void> {
    if (catalog.length && performance.now() - builtAt < TTL) return;
    const [ca, tfl, fl] = await Promise.all([fetchCaltrans(), fetchTfl(), fetchFlorida()]);
    catalog = [...ca, ...tfl, ...fl];
    builtAt = performance.now();
  }

  return {
    name: 'traffic-cams',
    configureServer(server) {
      server.middlewares.use('/api/trafficcams', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          await ensureCatalog();
          const url = new URL(req.url || '', 'http://localhost');
          const swLat = Number(url.searchParams.get('lamin'));
          const neLat = Number(url.searchParams.get('lamax'));
          const swLon = Number(url.searchParams.get('lomin'));
          const neLon = Number(url.searchParams.get('lomax'));
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 400));
          let cams = catalog;
          if ([swLat, neLat, swLon, neLon].every(Number.isFinite)) {
            cams = catalog.filter((c) => c.lat >= swLat && c.lat <= neLat && c.lon >= swLon && c.lon <= neLon);
          }
          res.end(JSON.stringify({ total: catalog.length, count: Math.min(cams.length, limit), cams: cams.slice(0, limit) }));
        } catch (error) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'traffic cams failed', cams: [] }));
        }
      });
    },
  };
}

// Dev-only proxy for upcoming rocket launches (The Space Devs Launch Library 2,
// free/no key). Cached 30 min — LL2 rate-limits the detailed endpoint.
function launchesPlugin(): Plugin {
  let cache: { body: string; expiresAt: number } | null = null;
  return {
    name: 'rocket-launches',
    configureServer(server) {
      server.middlewares.use('/api/launches', async (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          if (cache && cache.expiresAt > performance.now()) { res.end(cache.body); return; }
          const r = await fetch('https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=12', {
            headers: { 'User-Agent': 'worldmonitor-selfhost/1.0', Accept: 'application/json' },
            signal: AbortSignal.timeout(12_000),
          });
          if (!r.ok) { res.statusCode = 502; res.end(JSON.stringify({ error: `LL2 HTTP ${r.status}`, launches: [] })); return; }
          const d = await r.json() as { results?: Array<Record<string, unknown>> };
          const launches = (d.results ?? []).map((l) => {
            const pad = (l.pad ?? {}) as Record<string, unknown>;
            const loc = (pad.location ?? {}) as Record<string, unknown>;
            const prov = (l.launch_service_provider ?? {}) as Record<string, unknown>;
            const mission = (l.mission ?? {}) as Record<string, unknown>;
            return {
              name: l.name ?? '',
              net: l.net ?? null,
              provider: prov.name ?? null,
              mission: mission.name ?? null,
              status: ((l.status ?? {}) as Record<string, unknown>).abbrev ?? null,
              pad: loc.name ?? pad.name ?? null,
              lat: pad.latitude != null ? Number(pad.latitude) : null,
              lon: pad.longitude != null ? Number(pad.longitude) : null,
            };
          });
          const body = JSON.stringify({ count: launches.length, launches });
          cache = { body, expiresAt: performance.now() + 30 * 60_000 };
          res.end(body);
        } catch (error) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'launches failed', launches: [] }));
        }
      });
    },
  };
}

// Dev-only weather proxy (all free / no key): NHC active tropical cyclones,
// NWS severe-weather alerts (needs a descriptive User-Agent), and Open-Meteo
// current conditions. `?kind=storms|alerts|current`.
function weatherPlugin(): Plugin {
  const UA = '(anwcc-command-center, self-host)';
  let stormCache: { body: string; expiresAt: number } | null = null;
  return {
    name: 'weather',
    configureServer(server) {
      server.middlewares.use('/api/weather', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const url = new URL(req.url || '', 'http://localhost');
          const kind = url.searchParams.get('kind') || 'storms';
          const lat = url.searchParams.get('lat');
          const lon = url.searchParams.get('lon');

          if (kind === 'storms') {
            if (stormCache && stormCache.expiresAt > performance.now()) { res.end(stormCache.body); return; }
            const r = await fetch('https://www.nhc.noaa.gov/CurrentStorms.json', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12_000) });
            if (!r.ok) { res.statusCode = 502; res.end(JSON.stringify({ error: `NHC HTTP ${r.status}`, activeStorms: [] })); return; }
            const body = await r.text();
            stormCache = { body, expiresAt: performance.now() + 10 * 60_000 };
            res.end(body);
            return;
          }
          if (kind === 'alerts') {
            const area = url.searchParams.get('area');
            const q = area ? `area=${encodeURIComponent(area)}` : (lat && lon ? `point=${encodeURIComponent(`${lat},${lon}`)}` : '');
            const r = await fetch(`https://api.weather.gov/alerts/active?${q}`, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' }, signal: AbortSignal.timeout(12_000) });
            if (!r.ok) { res.statusCode = 502; res.end(JSON.stringify({ error: `NWS HTTP ${r.status}`, features: [] })); return; }
            res.end(await r.text());
            return;
          }
          if (kind === 'current') {
            if (!lat || !lon) { res.statusCode = 400; res.end(JSON.stringify({ error: 'lat/lon required' })); return; }
            const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,weather_code&wind_speed_unit=kn&temperature_unit=fahrenheit`, { signal: AbortSignal.timeout(10_000) });
            if (!r.ok) { res.statusCode = 502; res.end(JSON.stringify({ error: `Open-Meteo HTTP ${r.status}` })); return; }
            res.end(await r.text());
            return;
          }
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'unknown kind' }));
        } catch (error) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'weather failed' }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Inject environment variables from .env files into process.env.
  // This ensures that API keys and other secrets in .env.local are
  // available to the dev server plugins and server-side handlers.
  Object.assign(process.env, env);

  // Dev-server port: DEV_PORT overrides the 3000 default. Reject non-integer or
  // out-of-range values (fall back to 3000) so a typo can't crash Vite's listen()
  // with ERR_SOCKET_BAD_PORT. Not VITE_-prefixed, so it never reaches the client bundle.
  const parsedDevPort = Number(env.DEV_PORT);
  const devPort =
    Number.isInteger(parsedDevPort) && parsedDevPort >= 1 && parsedDevPort <= 65535
      ? parsedDevPort
      : 3000;

  const isE2E = process.env.VITE_E2E === '1';
  const isDesktopBuild = process.env.VITE_DESKTOP_RUNTIME === '1';
  const activeVariant = process.env.VITE_VARIANT || 'full';
  const activeMeta = VARIANT_META[activeVariant] || VARIANT_META.full;
  const emitPublicSourceMaps = process.env.WM_EMIT_SOURCEMAPS === '1'
    || process.env.VERCEL_ENV === 'preview';
  // Sentry source-map upload. Gated on the token so a build without it (local,
  // fork, CI) behaves exactly as before rather than failing. Matching is by
  // debug ID — the plugin stamps the same id into the bundle and its map.
  const uploadSourceMapsToSentry = Boolean(process.env.SENTRY_AUTH_TOKEN);
  const sentryBuild = getSentryBuildMetadata(pkg.version, process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev');
  const publishSentryRelease = process.env.VERCEL_ENV === 'production' && Boolean(sentryBuild.dist);

  return {
    html: {
      cspNonce: STATIC_SCRIPT_NONCE,
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      // Resolved + build-time validated above (devDependencies fallback +
      // non-empty + major-pairing guards).
      __CLERK_JS_VERSION__: JSON.stringify(CLERK_JS_VERSION),
      // Vercel sets VERCEL_GIT_COMMIT_SHA on production + preview builds.
      // Local `vite build` falls back to 'dev' — installStaleBundleCheck
      // detects the marker and skips the comparison so dev tabs don't
      // reload on every focus.
      __BUILD_HASH__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev'),
    },
    plugins: [
      realtimeTokenPlugin(),
      openskyPlugin(),
      adsbLolPlugin(),
      routeLookupPlugin(),
      issTlePlugin(),
      trafficCamsPlugin(),
      launchesPlugin(),
      weatherPlugin(),
      // Ship readable dashboard stack traces to Sentry. Without this every
      // browser frame arrives minified (`Rs.loadNews`, `BO`, `v`), which is why
      // triage has had to infer call sites from Vite chunk names.
      ...(uploadSourceMapsToSentry
        ? [sentryVitePlugin({
            org: 'elie-habib',
            project: 'worldmonitor',
            authToken: process.env.SENTRY_AUTH_TOKEN,
            telemetry: false,
            release: {
              name: sentryBuild.release,
              inject: false,
              dist: sentryBuild.dist,
              // Preview/local uploads must not resolve shared production issues.
              create: publishSentryRelease,
              finalize: publishSentryRelease,
              // Preserve the plugin's Vercel-aware commit detection in production.
              setCommits: publishSentryRelease ? undefined : false,
              deploy: publishSentryRelease ? undefined : false,
            },
            sourcemaps: {
              // Previews deliberately serve public maps (emitPublicSourceMaps);
              // leave those in place and only sweep them when production built
              // them solely to upload.
              filesToDeleteAfterUpload: emitPublicSourceMaps ? [] : ['dist/**/*.map'],
            },
          })]
        : []),
      // Emit dist/build-hash.txt with the deployed SHA so the running bundle
      // can fetch /build-hash.txt at tab-focus time and force-reload itself
      // if it's running an older bundle (see src/bootstrap/stale-bundle-check.ts).
      // Same-origin static asset, NOT under /api/* — installWebApiRedirect
      // doesn't touch it, so the comparison reflects the web deployment.
      {
        name: 'wm-emit-build-hash',
        apply: 'build',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'build-hash.txt',
            source: process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev',
          });
        },
      },
      htmlVariantPlugin(activeMeta, activeVariant, isDesktopBuild),
      chunkSizeWarningPolicyPlugin(),
      !isDesktopBuild && dashboardHtmlOutputPlugin(),
      // Variant subdomain SEO pages only make sense on the web deployment,
      // which is always the 'full' build (variant selection is runtime by
      // hostname). Desktop and dedicated VITE_VARIANT builds skip it.
      !isDesktopBuild && activeVariant === 'full' && variantDashboardHtmlPlugin(),
      webMcpDevSecurityHeadersPlugin(),
      polymarketPlugin(),
      rssProxyPlugin(),
      youtubeLivePlugin(),
      gpsjamDevPlugin(),
      sebufApiPlugin(),
      brotliPrecompressPlugin(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: false,

        includeAssets: [
          'offline.html',
          'favico/favicon.ico',
          'favico/apple-touch-icon.png',
          'favico/favicon-32x32.png',
        ],
        // Manifest install icons stay advertised in manifest.webmanifest, but
        // they are fetched on demand instead of forced into first-visit SW
        // precache with the rest of the dashboard shell.
        includeManifestIcons: false,

        manifest: {
          name: `${activeMeta.siteName} - ${activeMeta.subject}`,
          short_name: activeMeta.shortName,
          description: activeMeta.description,
          start_url: '/dashboard',
          scope: '/',
          display: 'standalone',
          orientation: 'any',
          theme_color: '#0a0f0a',
          background_color: '#0a0f0a',
          categories: activeMeta.categories,
          icons: [
            { src: '/favico/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: '/favico/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
            { src: '/favico/android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },

        workbox: {
          globPatterns: ['**/*.{js,css,ico,png,svg,woff2}'],
          globIgnores: [
            '**/ml*.js',
            '**/onnx*.wasm',
            '**/locale-*.js',
            '**/clerk-*.js',
            // Fonts are fetched only when their stylesheet applies. Precache
            // would pull every local weight into the first mobile visit.
            '**/*.woff2',
            // Keep off-page/static-heavy public assets out of the dashboard's
            // first-visit precache. The small root favicons above remain
            // explicit includeAssets entries.
            'pro/**',
            'favico/**',
            'textures/**',
            // #4891: blog OG covers + post images are generated into the prod
            // build (absent locally), and the png glob was precaching all ~40
            // of them (~700KB) on every first dashboard visit — and again on
            // each SW update after a blog deploy. Blog pages fetch their own
            // images on demand; the dashboard never needs them.
            'blog/**',
          ],
          // globe.gl + three.js grows main bundle past the 2 MiB default limit
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          navigateFallback: null,
          skipWaiting: true,
          clientsClaim: true,
          cleanupOutdatedCaches: true,
          // Web Push handler (Phase 6). importScripts runs in the SW
          // context; /push-handler.js is a static file copied from
          // public/ and attaches 'push' + 'notificationclick' listeners.
          importScripts: ['/push-handler.js', '/sw-navigation.js'],

          // Navigations are handled by public/sw-navigation.js (network-first
          // with an offline.html fallback), NOT by a runtime cache: a cached
          // index.html survives cleanupOutdatedCaches while its hashed chunks
          // are purged with the old precache, so an offline reload after any
          // deploy used to 404 the bundle and blank the dashboard.
          runtimeCaching: [
            {
              urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
                sameOrigin && /^\/api\//.test(url.pathname),
              handler: 'NetworkOnly',
              method: 'GET',
            },
            {
              urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
                sameOrigin && /^\/api\//.test(url.pathname),
              handler: 'NetworkOnly',
              method: 'POST',
            },
            {
              urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
                sameOrigin && /^\/rss\//.test(url.pathname),
              handler: 'NetworkOnly',
              method: 'GET',
            },
            {
              urlPattern: ({ url }: { url: URL }) =>
                url.pathname.endsWith('.pmtiles') ||
                url.hostname.endsWith('.r2.dev') ||
                url.hostname === 'build.protomaps.com',
              handler: 'NetworkFirst',
              options: {
                cacheName: 'pmtiles-ranges',
                expiration: { maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /^https:\/\/protomaps\.github\.io\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'protomaps-assets',
                expiration: { maxEntries: 100, maxAgeSeconds: 365 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /\/assets\/locale-.*\.js$/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'locale-files',
                expiration: { maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/i,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'images',
                expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 },
              },
            },
          ],
        },

        devOptions: {
          enabled: false,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        child_process: resolve(__dirname, 'src/shims/child-process.ts'),
        'node:child_process': resolve(__dirname, 'src/shims/child-process.ts'),
        '@loaders.gl/worker-utils/dist/lib/process-utils/child-process-proxy.js': resolve(
          __dirname,
          'src/shims/child-process-proxy.ts'
        ),
      },
    },
    worker: {
      format: 'es',
    },
    build: {
      // Uploading requires the maps to exist. When they are not also being
      // published deliberately, the Sentry plugin deletes them after upload so
      // production keeps shipping no public maps.
      sourcemap: emitPublicSourceMaps || uploadSourceMapsToSentry,
      // Vite's global threshold accommodates the known lazy GlobeMap bundle.
      // wm-chunk-size-warning-policy keeps the 1200 kB default for every other
      // chunk so unrelated regressions between 1200 and 2000 kB remain visible.
      chunkSizeWarningLimit: 2000,
      // Vite 6 hoists every dynamic chunk's STATIC deps into the entry HTML's
      // modulepreload list to avoid latency on the first dynamic import. For the
      // map stack that defeats the whole point of dynamic-importing MapContainer:
      // ~3MB of WebGL deps would still download at parse time. Strip them here so
      // they only load when MapContainer's `await import(...)` actually fires
      // (still preloaded in parallel via __vitePreload at that moment).
      modulePreload: {
        resolveDependencies: (_filename, deps, { hostType }) => {
          if (hostType !== 'html') return deps;
          return deps.filter(d => !LAZY_HTML_PRELOAD_RE.test(d));
        },
      },
      rollupOptions: {
        onwarn(warning, warn) {
          // onnxruntime-web ships a minified browser bundle that intentionally uses eval.
          // Keep build logs focused by filtering this known third-party warning only.
          if (
            warning.code === 'EVAL'
            && typeof warning.id === 'string'
            && warning.id.includes('/onnxruntime-web/dist/ort-web.min.js')
          ) {
            return;
          }

          // The cyber client legitimately tree-shakes to nothing while its
          // feature flag is off. Keep every other empty RPC chunk visible: an
          // enabled client disappearing is a build regression, not noise.
          if (isExpectedEmptyRpcClientWarning(
            warning,
            process.env.VITE_ENABLE_CYBER_LAYER === 'true',
          )) {
            return;
          }

          warn(warning);
        },
        input: {
          main: resolve(__dirname, 'index.html'),
          embed: resolve(__dirname, 'embed.html'),
          settings: resolve(__dirname, 'settings.html'),
          liveChannels: resolve(__dirname, 'live-channels.html'),
          mcpGrant: resolve(__dirname, 'mcp-grant.html'),
        },
        output: {
          // onlyExplicitManualChunks keeps the panel clusters from forming
          // cross-chunk cycles. Its side effect: a manual chunk's unmatched
          // static deps get pulled into the importer chunk — which created a
          // circular DeckGLMap -> deck-stack -> DeckGLMap chunk (runtime TDZ
          // "Cannot access 'X' before initialization" that crashed the WebGL map
          // into the SVG fallback). Fixed by co-locating the DeckGLMap renderer
          // into the 'deck-stack' chunk below so deck deps never split across the
          // DeckGLMap boundary.
          onlyExplicitManualChunks: true,
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('/@xenova/transformers/')) {
                return 'transformers';
              }
              if (id.includes('/onnxruntime-web/')) {
                return 'onnxruntime';
              }
              // NOTE: chunk names below MUST match entries in LAZY_HTML_PRELOAD_CHUNKS
              // (top of file). The resolveDependencies filter relies on this string
              // identity; renaming here without updating the constant silently
              // re-eagerises the WebGL stack into the entry HTML's modulepreload list.
              if (id.includes('/maplibre-gl/')) {
                return 'maplibre';
              }
              if (id.includes('/pmtiles/') || id.includes('/@protomaps/basemaps/')) {
                return 'protomaps';
              }
              if (id.includes('/h3-js/')) {
                return 'h3-js';
              }
              if (
                id.includes('/@deck.gl/')
                || id.includes('/@luma.gl/')
                || id.includes('/@loaders.gl/')
                || id.includes('/@math.gl/')
              ) {
                return 'deck-stack';
              }
              if (id.includes('/d3/')) {
                return 'd3';
              }
              if (id.includes('/topojson-client/')) {
                return 'topojson';
              }
              if (id.includes('/i18next')) {
                return 'i18n';
              }
              if (id.includes('/@sentry/') || id.includes('/@sentry-internal/')) {
                return 'sentry';
              }
              if (id.includes('/@clerk/clerk-js/')) {
                // Clerk remains a runtime dynamic import; the stable chunk name
                // lets Workbox keep the large auth SDK out of precache.
                return 'clerk';
              }
            }
            // Large static config DATA TABLE (~62KB) with only lazy consumers
            // (search/map/globe/tech-hub services). Isolating it keeps it off the
            // eager entry now that the @/config barrel no longer re-exports its
            // values and data-loader lazy-loads the tech-activity chain. Pure
            // data (type-only imports) → no unmatched-static-dep circular risk. (#4404)
            if (id.endsWith('/src/config/tech-geo.ts')) {
              return 'tech-geo-data';
            }
            // airports table (~14KB) — only consumer is the lazy AviationCommandBar
            // (imports directly); kept off the eager @/config barrel above. (#4404)
            if (id.endsWith('/src/config/airports.ts')) {
              return 'airports-data';
            }
            // ai-datacenters table (~86KB) — consumers (map/globe/search) import
            // directly and are lazy; related-assets lazy-imports it. Kept off the
            // eager @/config barrel above. (#4404)
            if (id.endsWith('/src/config/ai-datacenters.ts')) {
              return 'ai-datacenters-data';
            }
            // geo-map table bulk (~150KB: UNDERSEA_CABLES + NUCLEAR_FACILITIES +
            // ECONOMIC_CENTERS/SPACEPORTS/CRITICAL_MINERALS/SANCTIONED_*/MAP_URLS).
            // Map/globe/search consumers import directly (lazy); the eager
            // related-assets/infrastructure-cascade/cable-activity chains
            // lazy-cache it. Kept off the eager @/config barrel above. (#4404)
            if (id.endsWith('/src/config/geo-map.ts')) {
              return 'geo-map-data';
            }
            // Military-bases bulk (~48KB MILITARY_BASES_EXPANDED + merged
            // MILITARY_BASES). geo.ts no longer imports it; eager consumers
            // (country-intel, related-assets, data-loader→military-surge)
            // lazy-load it via dynamic import. Kept off the eager @/config
            // barrel. Co-chunk both files so the merged list and its raw data
            // ship together off the entry chunk. (#4478)
            if (id.endsWith('/src/config/military-bases.ts') || id.endsWith('/src/config/bases-expanded.ts')
                || id.endsWith('/shared/military-bases-data.ts')) {
              return 'military-bases-data';
            }
            // Correlation engine (engine + 4 adapters) is dynamic-imported at its
            // post-loadAllData run site in App.ts (#4486), so it already forms a lazy
            // chunk; this rule only gives that chunk a STABLE name — the dir-index
            // would otherwise emit an ambiguous `index-*.js` the eager-chunk guard
            // can't pin. Naming only; the deferral is the call-site import().
            if (id.includes('/src/services/correlation-engine/')) {
              return 'correlation-engine';
            }
            // Post-paint service tail split (#4487). These files are dynamic-imported
            // from data-loader/country-intel/SignalModal; stable names let the
            // dist guard prove they stay out of main rather than merely grepping src.
            // Keep the product catalog independent from its shared cache and
            // entitlement dependencies. Before this split, Rollup named the shared
            // cache group `products`, making the post-hydration product task parse
            // unrelated IndexedDB code alongside the tiny checkout catalog. (#5165)
            if (id.endsWith('/src/config/products.ts') || id.endsWith('/src/config/products.generated.ts')) {
              return 'products';
            }
            if (id.endsWith('/src/services/persistent-cache.ts')) {
              return 'persistent-cache';
            }
            if (id.endsWith('/src/services/rss.ts')) {
              return 'rss';
            }
            if (id.endsWith('/src/services/trending-keywords.ts')) {
              return 'trending-keywords';
            }
            if (id.endsWith('/src/services/daily-market-brief.ts')) {
              return 'daily-market-brief';
            }
            if (id.endsWith('/src/services/signal-aggregator.ts')) {
              return 'signal-aggregator';
            }
            if (id.endsWith('/src/services/military-vessels.ts')) {
              return 'military-vessels';
            }
            if (id.endsWith('/src/services/cross-module-integration.ts')) {
              return 'cross-module-integration';
            }
            // Generated protobuf/RPC client modules are loaded through
            // src/services/generated-rpc-clients.ts so real constructors parse only
            // on first RPC use. Stable names let the eager-chunk guard prove they
            // stay out of the dashboard entry and HTML modulepreload list. (#4493)
            const rpcClientMatch = id.match(/\/src\/generated\/client\/worldmonitor\/(.+)\/service_client\.ts$/);
            if (rpcClientMatch) {
              return `rpc-client-${rpcClientMatch[1].replace(/_/g, '-').replace(/\//g, '-')}`;
            }
            // Co-locate the deck.gl renderer with the deck vendor chunk so
            // onlyExplicitManualChunks cannot split deck's transitive deps
            // across the DeckGLMap boundary (which formed a circular chunk →
            // runtime TDZ that crashed the WebGL map into the SVG fallback).
            if (id.endsWith('/src/components/DeckGLMap.ts')) {
              return 'deck-stack';
            }
            // Co-locate ResilienceWidget with its only runtime importer
            // (CountryDeepDivePanel, panels-intel). As a standalone chunk its
            // import() was a second network hop on every deep-dive open, and
            // filtering middleboxes that stub the *Widget*-named chunk URL with
            // an empty 200 made the import resolve WITHOUT the export
            // (Sentry WORLDMONITOR-T6). In-chunk resolution removes that
            // surface and the waterfall hop; shared deps (resilience-widget-
            // utils, services/resilience) already live in shared chunks.
            if (id.endsWith('/src/components/ResilienceWidget.ts')) {
              return 'panels-intel';
            }
            if (id.includes('/src/components/') && id.endsWith('.ts')) {
              const panelChunk = panelChunkForComponentId(id);
              if (panelChunk) return panelChunk;
            }
            // Give lazy-loaded locale chunks a recognizable prefix so the
            // service worker can exclude them from precache (en.json is
            // statically imported into the main bundle).
            const localeMatch = id.match(/\/locales\/(\w+)\.json$/);
            if (localeMatch && localeMatch[1] !== 'en') {
              return `locale-${localeMatch[1]}`;
            }
            return undefined;
          },
        },
      },
    },
    server: {
      port: devPort,
      open: !isE2E,
      hmr: isE2E ? false : undefined,
      watch: {
        ignored: [
          '**/test-results/**',
          '**/playwright-report/**',
          '**/.playwright-mcp/**',
        ],
      },
      proxy: {
        // Widget agent — forward to Railway relay for SSE streaming
        '/widget-agent': {
          target: 'https://proxy.worldmonitor.app',
          changeOrigin: true,
        },
        // Yahoo Finance API
        '/api/yahoo': {
          target: 'https://query1.finance.yahoo.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
        },
        // Polymarket handled by polymarketPlugin() — no prod proxy needed
        // USGS Earthquake API
        '/api/earthquake': {
          target: 'https://earthquake.usgs.gov',
          changeOrigin: true,
          timeout: 30000,
          rewrite: (path) => path.replace(/^\/api\/earthquake/, ''),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('Earthquake proxy error:', err.message);
            });
          },
        },
        // PizzINT - Pentagon Pizza Index
        '/api/pizzint': {
          target: 'https://www.pizzint.watch',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/pizzint/, '/api'),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('PizzINT proxy error:', err.message);
            });
          },
        },
        // FRED Economic Data - handled by Vercel serverless function in prod
        // In dev, we proxy to the API directly with the key from .env
        '/api/fred-data': {
          target: 'https://api.stlouisfed.org',
          changeOrigin: true,
          rewrite: (path) => {
            const url = new URL(path, 'http://localhost');
            const seriesId = url.searchParams.get('series_id');
            const start = url.searchParams.get('observation_start');
            const end = url.searchParams.get('observation_end');
            const apiKey = process.env.FRED_API_KEY || '';
            return `/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=10${start ? `&observation_start=${start}` : ''}${end ? `&observation_end=${end}` : ''}`;
          },
        },
        // RSS Feeds - BBC
        '/rss/bbc': {
          target: 'https://feeds.bbci.co.uk',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/bbc/, ''),
        },
        // RSS Feeds - Guardian
        '/rss/guardian': {
          target: 'https://www.theguardian.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/guardian/, ''),
        },
        // RSS Feeds - NPR
        '/rss/npr': {
          target: 'https://feeds.npr.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/npr/, ''),
        },
        // RSS Feeds - Al Jazeera
        '/rss/aljazeera': {
          target: 'https://www.aljazeera.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/aljazeera/, ''),
        },
        // RSS Feeds - CNN
        '/rss/cnn': {
          target: 'http://rss.cnn.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cnn/, ''),
        },
        // RSS Feeds - Hacker News
        '/rss/hn': {
          target: 'https://hnrss.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/hn/, ''),
        },
        // RSS Feeds - Ars Technica
        '/rss/arstechnica': {
          target: 'https://feeds.arstechnica.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/arstechnica/, ''),
        },
        // RSS Feeds - The Verge
        '/rss/verge': {
          target: 'https://www.theverge.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/verge/, ''),
        },
        // RSS Feeds - CNBC
        '/rss/cnbc': {
          target: 'https://www.cnbc.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cnbc/, ''),
        },
        // RSS Feeds - MarketWatch
        '/rss/marketwatch': {
          target: 'https://feeds.marketwatch.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/marketwatch/, ''),
        },
        // RSS Feeds - Defense/Intel sources
        '/rss/defenseone': {
          target: 'https://www.defenseone.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/defenseone/, ''),
        },
        '/rss/warontherocks': {
          target: 'https://warontherocks.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/warontherocks/, ''),
        },
        '/rss/breakingdefense': {
          target: 'https://breakingdefense.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/breakingdefense/, ''),
        },
        '/rss/bellingcat': {
          target: 'https://www.bellingcat.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/bellingcat/, ''),
        },
        // RSS Feeds - TechCrunch (layoffs)
        '/rss/techcrunch': {
          target: 'https://techcrunch.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/techcrunch/, ''),
        },
        // Google News RSS
        '/rss/googlenews': {
          target: 'https://news.google.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/googlenews/, ''),
        },
        // AI Company Blogs
        '/rss/openai': {
          target: 'https://openai.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/openai/, ''),
        },
        '/rss/anthropic': {
          target: 'https://www.anthropic.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/anthropic/, ''),
        },
        '/rss/googleai': {
          target: 'https://blog.google',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/googleai/, ''),
        },
        '/rss/deepmind': {
          target: 'https://deepmind.google',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/deepmind/, ''),
        },
        '/rss/huggingface': {
          target: 'https://huggingface.co',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/huggingface/, ''),
        },
        '/rss/techreview': {
          target: 'https://www.technologyreview.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/techreview/, ''),
        },
        '/rss/arxiv': {
          target: 'https://rss.arxiv.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/arxiv/, ''),
        },
        // Government
        '/rss/whitehouse': {
          target: 'https://www.whitehouse.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/whitehouse/, ''),
        },
        '/rss/statedept': {
          target: 'https://www.state.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/statedept/, ''),
        },
        '/rss/state': {
          target: 'https://www.state.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/state/, ''),
        },
        '/rss/defense': {
          target: 'https://www.defense.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/defense/, ''),
        },
        '/rss/justice': {
          target: 'https://www.justice.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/justice/, ''),
        },
        '/rss/cdc': {
          target: 'https://tools.cdc.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cdc/, ''),
        },
        '/rss/fema': {
          target: 'https://www.fema.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/fema/, ''),
        },
        '/rss/dhs': {
          target: 'https://www.dhs.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/dhs/, ''),
        },
        '/rss/fedreserve': {
          target: 'https://www.federalreserve.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/fedreserve/, ''),
        },
        '/rss/sec': {
          target: 'https://www.sec.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/sec/, ''),
        },
        '/rss/treasury': {
          target: 'https://home.treasury.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/treasury/, ''),
        },
        '/rss/cisa': {
          target: 'https://www.cisa.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cisa/, ''),
        },
        // Think Tanks
        '/rss/brookings': {
          target: 'https://www.brookings.edu',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/brookings/, ''),
        },
        '/rss/cfr': {
          target: 'https://www.cfr.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/cfr/, ''),
        },
        '/rss/csis': {
          target: 'https://www.csis.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/csis/, ''),
        },
        // Defense
        '/rss/warzone': {
          target: 'https://www.thedrive.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/warzone/, ''),
        },
        '/rss/defensegov': {
          target: 'https://www.defense.gov',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/defensegov/, ''),
        },
        // Security
        '/rss/krebs': {
          target: 'https://krebsonsecurity.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/krebs/, ''),
        },
        // Finance
        '/rss/yahoonews': {
          target: 'https://finance.yahoo.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/yahoonews/, ''),
        },
        // Diplomat
        '/rss/diplomat': {
          target: 'https://thediplomat.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/diplomat/, ''),
        },
        // VentureBeat
        '/rss/venturebeat': {
          target: 'https://venturebeat.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/venturebeat/, ''),
        },
        // Foreign Policy
        '/rss/foreignpolicy': {
          target: 'https://foreignpolicy.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/foreignpolicy/, ''),
        },
        // Financial Times
        '/rss/ft': {
          target: 'https://www.ft.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/ft/, ''),
        },
        // Reuters
        '/rss/reuters': {
          target: 'https://www.reutersagency.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rss\/reuters/, ''),
        },
        // Cloudflare Radar - Internet outages
        '/api/cloudflare-radar': {
          target: 'https://api.cloudflare.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/cloudflare-radar/, ''),
        },
        // NGA Maritime Safety Information - Navigation Warnings
        '/api/nga-msi': {
          target: 'https://msi.nga.mil',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/nga-msi/, ''),
        },
        // GDELT GEO 2.0 API - Global event data
        '/api/gdelt': {
          target: 'https://api.gdeltproject.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/gdelt/, ''),
        },
        // AISStream WebSocket proxy for live vessel tracking
        '/ws/aisstream': {
          target: 'wss://stream.aisstream.io',
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/ws\/aisstream/, ''),
        },
        // FAA NASSTATUS - Airport delays and closures
        '/api/faa': {
          target: 'https://nasstatus.faa.gov',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/faa/, ''),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('FAA NASSTATUS proxy error:', err.message);
            });
          },
        },
        // OpenSky Network - Aircraft tracking (military flight detection).
        // Prod routes /api/opensky through the relay (api/opensky.js), which calls
        // OpenSky's states/all endpoint. Dev has no relay, so proxy straight to
        // states/all — stripping the prefix to '' would hit the invalid /api root (404).
        '/api/opensky': {
          target: 'https://opensky-network.org/api',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/opensky/, '/states/all'),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('OpenSky proxy error:', err.message);
            });
          },
        },
        // ADS-B Exchange - Military aircraft tracking (backup/supplement)
        '/api/adsb-exchange': {
          target: 'https://adsbexchange.com/api',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/adsb-exchange/, ''),
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.log('ADS-B Exchange proxy error:', err.message);
            });
          },
        },
      },
    },
  };
});
