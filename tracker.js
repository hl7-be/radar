// CareSet Console — Hierarchical Explorer
// Views: Explorer (primary), Pipeline, Gaps, Download, Report

let data = {};
let currentView = 'explorer';
let explorerMode = 'packages'; // packages | projects | caresets | published | artifacts
let showHistoricalArtifacts = false; // when true, includes artifacts only in past deliveries
let showBranches = true;             // when true, Timeline overlays repo branches per IG
let showStaleBranches = true;        // default: show everything, including merged branches whose curves arc back to main

// Expose data globally so crawler module can read/update it
window._trackerData = data;

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function bootstrap() {
    await loadData();
    window._trackerData = data;
    // Honour the URL hash (e.g. #/branches) so links can deep-link directly
    // to a view; fall back to Explorer when no hash is present.
    const initialView = readViewFromHash() || 'explorer';
    switchView(initialView);
    // Sync state on browser back/forward
    window.addEventListener('hashchange', () => {
        const v = readViewFromHash();
        if (v && v !== currentView) switchView(v);
    });
}

function readViewFromHash() {
    const h = (window.location.hash || '').replace(/^#\/?/, '').trim();
    if (!h) return null;
    // Accept "branches", "/branches", or "#/branches"
    return h.split(/[\/?]/, 1)[0];
}

// If DOM is already ready (script loaded dynamically after DOMContentLoaded),
// run immediately. Otherwise wait for the event.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}

async function loadData() {
    data = { context: { shortName: '?' }, projects: [], caresets: [], packages: {}, expansions: {} };

    // Load be.yaml
    try {
        const resp = await fetch('data/be.yaml');
        if (!resp.ok) throw new Error('be.yaml HTTP ' + resp.status);
        const text = await resp.text();
        const parsed = jsyaml.load(text);
        if (parsed) {
            data = parsed;
            if (!data.packages) data.packages = {};
            if (!data.expansions) data.expansions = {};
        }
        console.log('be.yaml loaded:', (data.projects||[]).length, 'projects,', (data.caresets||[]).length, 'caresets');
    } catch (e) {
        console.error('Failed to load be.yaml:', e);
    }

    // Load packages.yaml
    data.registries = [];
    try {
        const resp = await fetch('data/packages.yaml');
        if (resp && resp.ok) {
            const pkgData = jsyaml.load(await resp.text());
            data.packages = (pkgData && pkgData.packages) ? pkgData.packages : {};
            data.registries = (pkgData && pkgData.registries) ? pkgData.registries : [];
            // Mark explicit packages so we know they came from the YAML
            for (const key of Object.keys(data.packages)) {
                data.packages[key].source = 'explicit';
            }
            console.log('packages.yaml loaded:', Object.keys(data.packages).length, 'packages');
        }
    } catch (e) {
        console.error('Failed to load packages.yaml:', e);
    }

    // Fetch external package registries and merge any packages not already listed.
    // Strategy:
    //   1. Try the build-time snapshot at data/registry-cache.json (works on any
    //      static host, including GitHub Pages, with no CORS issues).
    //   2. On localhost (dev), fall back to the Vite proxy for a live fetch.
    //   3. Otherwise skip with a warning — the registry is unreachable cross-origin.
    let cache = null;
    try {
        const cacheResp = await fetch('data/registry-cache.json');
        if (cacheResp.ok) cache = await cacheResp.json();
    } catch (e) { /* no cache present — that's OK in dev */ }

    for (const reg of data.registries) {
        let regData = null;
        if (cache) {
            const entry = (cache.registries || []).find(r => r.url === reg.url);
            if (entry && entry.data) regData = entry.data;
        }
        if (!regData && location.hostname === 'localhost' && reg.url.startsWith('https://ehealth.fgov.be')) {
            try {
                const proxyUrl = reg.url.replace('https://ehealth.fgov.be', '/proxy/ehealth');
                const resp = await fetch(proxyUrl);
                if (resp.ok) regData = await resp.json();
            } catch (e) { /* fall through */ }
        }
        if (!regData) {
            console.warn(`Registry "${reg.name}" not available (no cache, no proxy). Run: npm run fetch:registry`);
            continue;
        }

        let added = 0, enriched = 0, skipped = 0;
        for (const entry of (regData.packages || [])) {
            const id = entry['package-id'];
            if (!id) continue;

            // Prefer the full version history fetched from package-list.json;
            // fall back to just the `latest` entry if that follow-up fetch failed.
            const fullVersions = (entry.allVersions && entry.allVersions.length > 0)
                ? entry.allVersions.map(v => ({
                    version: v.version,
                    date: v.date ? (v.date.length === 10 ? v.date + 'T12:00:00.000Z' : v.date) : null,
                    description: v.description || null
                }))
                : (entry.latest ? [{
                    version: entry.latest.version,
                    date: entry.latest.date ? entry.latest.date + 'T12:00:00.000Z' : null,
                    description: null
                }] : []);
            const curVer = entry.latest ? entry.latest.version : (fullVersions[0] && fullVersions[0].version);

            if (data.packages[id]) {
                // Explicit package already listed — enrich missing fields from the registry
                const ex = data.packages[id];
                let changed = false;
                if (!ex.currentVersion && curVer) { ex.currentVersion = curVer; changed = true; }
                if ((!ex.allVersions || ex.allVersions.length === 0) && fullVersions.length) { ex.allVersions = fullVersions; changed = true; }
                if (!ex.title && entry.title) { ex.title = entry.title; }
                if (!ex.publicationUrl && entry.canonical) { ex.publicationUrl = entry.canonical; }
                if (changed) { ex.enrichedBy = reg.name; enriched++; } else { skipped++; }
                continue;
            }

            data.packages[id] = {
                source: 'registry',
                sourceName: reg.name,
                title: entry.title || null,
                repository: entry['ci-build'] ? entry['ci-build'].replace(/^https?:\/\/build\.fhir\.org\/ig\//, '') : null,
                igUrl: entry['ci-build'] || null,
                publicationUrl: entry.canonical || null,
                currentVersion: curVer,
                allVersions: fullVersions
            };
            added++;
        }
        console.log(`registry ${reg.name}: added ${added}, enriched ${enriched}, skipped ${skipped}`);
    }

    // Pass the build-time CI and branch metadata through to the runtime data
    // object so Health controls can read it synchronously.
    if (cache) {
        data.ciBuilds = cache.ciBuilds || {};
        data.branches = cache.branches || {};
    }

    // Enrich explicit packages from build-time publication probes (package-list.json / qa.json)
    if (cache && cache.publications) {
        let probeEnriched = 0;
        for (const [id, probe] of Object.entries(cache.publications)) {
            const ex = data.packages[id];
            if (!ex || !probe || !probe.allVersions || probe.allVersions.length === 0) continue;
            const probeVersions = probe.allVersions.map(v => ({
                version: v.version,
                date: v.date ? (v.date.length === 10 ? v.date + 'T12:00:00.000Z' : v.date) : null,
                description: v.description || null
            }));
            let changed = false;
            if (!ex.currentVersion) { ex.currentVersion = probeVersions[0].version; changed = true; }
            if (!ex.allVersions || ex.allVersions.length === 0) { ex.allVersions = probeVersions; changed = true; }
            if (changed) { ex.enrichedBy = `${probe.source} at ${ex.publicationUrl}`; probeEnriched++; }
        }
        if (probeEnriched) console.log(`publication probes: enriched ${probeEnriched} explicit packages`);
    }

    // Load expansions.json
    try {
        const resp = await fetch('data/expansions.json');
        if (resp && resp.ok) {
            data.expansions = await resp.json();
        }
    } catch (e) { /* optional file */ }

    // Load controls.yaml (quality/monitoring checks metadata)
    try {
        const resp = await fetch('data/controls.yaml');
        if (resp && resp.ok) {
            const parsed = jsyaml.load(await resp.text());
            data.controls = (parsed && parsed.controls) || [];
            console.log('controls.yaml loaded:', data.controls.length, 'controls');
        }
    } catch (e) { /* optional */ }

    // Load repos.yaml (per-IG branch metadata for the Timeline branch overlay)
    try {
        const resp = await fetch('data/repos.yaml');
        if (resp && resp.ok) {
            const parsed = jsyaml.load(await resp.text());
            data.repos = (parsed && parsed.repos) || [];
            console.log('repos.yaml loaded:', data.repos.length, 'repos (',
                data.repos.filter(r => r.relevant).length, 'marked relevant)');
        }
    } catch (e) { /* optional */ }

    // Load active-igs.yaml + groups.yaml (governance artifacts)
    try {
        const resp = await fetch('data/active-igs.yaml');
        if (resp && resp.ok) {
            const parsed = jsyaml.load(await resp.text());
            data.activeIGs = (parsed && parsed.activeIGs) || [];
            console.log('active-igs.yaml loaded:', data.activeIGs.length, 'active IGs');
        }
    } catch (e) { /* optional */ }
    try {
        const resp = await fetch('data/groups.yaml');
        if (resp && resp.ok) {
            const parsed = jsyaml.load(await resp.text());
            data.groups = (parsed && parsed.groups) || [];
            console.log('groups.yaml loaded:', data.groups.length, 'groups');
        }
    } catch (e) { /* optional */ }

    // Load Belgian_Refsets.tsv (external import — authored by terminology team).
    // Header: Purpose<TAB>Subset<TAB>SCTID
    try {
        const resp = await fetch('data/imports/Belgian_Refsets.tsv');
        if (resp && resp.ok) {
            const text = await resp.text();
            const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
            const header = lines.shift().split('\t');
            const idx = { purpose: header.indexOf('Purpose'), subset: header.indexOf('Subset'), sctid: header.indexOf('SCTID') };
            data.refsets = lines.map(l => {
                const cols = l.split('\t');
                return { purpose: cols[idx.purpose], subset: cols[idx.subset], sctid: (cols[idx.sctid] || '').trim() };
            }).filter(r => r.sctid);
            console.log('Belgian_Refsets.tsv loaded:', data.refsets.length, 'refsets');
        }
    } catch (e) { /* optional */ }

    // Feature toggles — hide views that aren't appropriate for this build
    // (e.g. crawl + report are typically off in deployed/online builds).
    try {
        const resp = await fetch('data/features.yaml');
        if (resp && resp.ok) {
            const parsed = jsyaml.load(await resp.text());
            data.features = (parsed && parsed.features) || {};
        }
    } catch (e) { /* optional — default is everything enabled */ }

    // Local overrides — gitignored, machine-specific. Anything in here wins
    // over features.yaml so you can flip views on/off without affecting the
    // team-shared config.
    try {
        const resp = await fetch('data/features.local.yaml');
        if (resp && resp.ok) {
            const parsed = jsyaml.load(await resp.text());
            const localFeatures = (parsed && parsed.features) || {};
            data.features = { ...(data.features || {}), ...localFeatures };
            const overridden = Object.keys(localFeatures);
            if (overridden.length > 0) console.log('Local feature overrides applied:', overridden.join(', '));
        }
    } catch (e) { /* optional */ }
    applyFeatureToggles();

    // Synthesize projects + caresets for packages not referenced by any careset,
    // so registry-only packages (and any other untracked packages) appear in the
    // Pipeline / Explorer / Reports views. Synthetic entries carry source: 'synth'
    // so the UI can render them differently.
    synthesizeCaresetsForUntrackedPackages();

    window._trackerData = data;
    document.getElementById('contextName').textContent =
        data.context ? data.context.name : 'Unknown';
}

function synthesizeCaresetsForUntrackedPackages() {
    if (!data.packages) return;
    if (!data.projects) data.projects = [];
    if (!data.caresets) data.caresets = [];

    // Collect every package name already referenced by a careset delivery
    const tracked = new Set();
    for (const cs of data.caresets) {
        for (const d of (cs.deliveries || [])) {
            for (const layer of ['l2', 't', 'l3']) {
                for (const p of (d[layer] || [])) {
                    if (p.package) tracked.add(p.package);
                }
            }
        }
    }

    const existingProjectIds = new Set(data.projects.map(p => p.id));
    const existingCaresetIds = new Set(data.caresets.map(c => c.id));

    for (const [pkgName, info] of Object.entries(data.packages)) {
        if (tracked.has(pkgName)) continue;

        // Short name used for display + id generation (e.g. hl7.fhir.be.childreport -> childreport)
        const short = pkgName.replace(/^hl7\.fhir\.\w+\./, '');
        const projectId = uniqueId('be-' + short, existingProjectIds);
        const caresetId = uniqueId(short, existingCaresetIds);
        existingProjectIds.add(projectId);
        existingCaresetIds.add(caresetId);

        // Derive status: a published currentVersion means the package is out on ehealth.
        const isPublished = !!(info.currentVersion && (info.allVersions || []).length > 0);
        const status = isPublished ? 'published' : 'planned';

        const sourceLabel = info.source === 'registry' ? (info.sourceName || 'registry') : 'package';

        data.projects.push({
            id: projectId,
            name: info.title || short,
            description: info.title || `Auto-registered from ${sourceLabel}`,
            transversal: false,
            status,
            repository: info.repository || null,
            dependencies: [],
            proposals: [],
            source: 'synth',
            sourceOrigin: info.source || 'explicit'
        });

        data.caresets.push({
            id: caresetId,
            name: info.title || short,
            description: info.title || `Auto-registered from ${sourceLabel}`,
            project: projectId,
            status,
            source: 'synth',
            sourceOrigin: info.source || 'explicit',
            deliveries: [{
                version: info.currentVersion || '0.0.0',
                status,
                current: true,
                initiatedDate: null,
                document: null,
                l2: [],
                t: [],
                // Treat the package as a Technical-layer delivery by default —
                // registry entries don't tell us the layer split.
                l3: [{
                    package: pkgName,
                    version: info.currentVersion || '0.0.0',
                    status,
                    artifacts: []
                }]
            }]
        });
    }
}

function uniqueId(base, taken) {
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
}

// ── Navigation ─────────────────────────────────────────────────────────────
// Called from the Timeline (interactive) group labels. Switches to the Explorer,
// selects the Packages tab, then opens + scrolls to the clicked package.
// Hide sidebar entries whose feature flag is `false`. Called once after
// loadData(). A view is considered enabled unless features[viewName] === false.
function applyFeatureToggles() {
    const features = (data && data.features) || {};
    document.querySelectorAll('.nav-item[data-view]').forEach(el => {
        const view = el.getAttribute('data-view');
        if (features[view] === false) el.style.display = 'none';
    });
}

function isFeatureEnabled(view) {
    const features = (data && data.features) || {};
    return features[view] !== false;
}

function jumpToPackageInExplorer(pkgName) {
    explorerMode = 'packages';
    switchView('explorer');
    // Give the DOM a tick to render, then find and expand the matching node.
    setTimeout(() => {
        const nodes = document.querySelectorAll('.exp-node .exp-header .exp-name');
        for (const n of nodes) {
            if (n.textContent.trim() === pkgName) {
                const header = n.closest('.exp-header');
                const children = header.nextElementSibling;
                if (children && !children.classList.contains('open')) toggleExp(header);
                header.scrollIntoView({ behavior: 'smooth', block: 'center' });
                header.closest('.exp-node').style.transition = 'box-shadow 0.3s';
                header.closest('.exp-node').style.boxShadow = '0 0 0 2px var(--primary)';
                setTimeout(() => { header.closest('.exp-node').style.boxShadow = ''; }, 1500);
                break;
            }
        }
    }, 50);
}

function switchView(view) {
    currentView = view;
    document.querySelectorAll('.nav-item').forEach(el =>
        el.classList.toggle('active', el.dataset.view === view)
    );
    // Reflect the active view in the URL hash so links to e.g. #/branches
    // deep-link straight into that view.
    const desiredHash = '#/' + view;
    if (window.location.hash !== desiredHash) {
        // Use replaceState to avoid bloating the back-stack on every click
        history.replaceState(null, '', desiredHash);
    }
    const titles = {
        explorer: 'Explorer',
        pipeline: 'Delivery Pipeline',
        timeline: 'IG Timeline',
        gaps: 'Gap Analysis',
        health: 'Health',
        groups: 'Workgroups',
        branches: 'Branch Activity',
        refsets: 'Belgian SNOMED Refsets',
        selector: 'Artifact Selector & Download',
        reports: 'Reports',
        crawl: 'Crawl Registry',
        report: 'Report Progress'
    };
    // Feature gate: redirect away from disabled views (e.g. crawl/report on a
    // deployed build) instead of rendering an empty page.
    if (!isFeatureEnabled(view)) {
        view = 'explorer';
        currentView = view;
    }
    document.getElementById('viewTitle').textContent = titles[view] || view;
    document.getElementById('topbarActions').innerHTML = '';
    const renderers = {
        explorer: renderExplorer,
        pipeline: renderPipeline,
        timeline: renderTimelineInteractive,
        gaps: renderGaps,
        health: renderHealth,
        groups: renderGroups,
        branches: renderBranches,
        refsets: renderRefsets,
        selector: renderSelector,
        reports: renderReports,
        crawl: window.renderCrawl || (() => {}),
        report: renderReport
    };
    (renderers[view] || renderExplorer)();
}


// ═══════════════════════════════════════════════════════════════════════════
// DataTable component
// ═══════════════════════════════════════════════════════════════════════════
class DataTable {
    constructor(containerId, config) {
        this.containerId = containerId;
        this.columns = config.columns;
        this.data = config.data || [];
        this.onRowClick = config.onRowClick || null;
        this.pageSize = config.pageSize || 15;
        this.page = 0;
        this.sortCol = config.defaultSort || null;
        this.sortDir = config.defaultSortDir || 'asc';
        this.searchText = '';
        this.render();
    }

    getFilteredData() {
        let rows = [...this.data];
        if (this.searchText) {
            const q = this.searchText.toLowerCase();
            rows = rows.filter(row =>
                this.columns.some(col => {
                    const val = col.searchVal ? col.searchVal(row) : (row[col.key] ?? '');
                    return String(val).toLowerCase().includes(q);
                })
            );
        }
        if (this.sortCol !== null) {
            const col = this.columns[this.sortCol];
            rows.sort((a, b) => {
                const va = col.sortVal ? col.sortVal(a) : (a[col.key] ?? '');
                const vb = col.sortVal ? col.sortVal(b) : (b[col.key] ?? '');
                let cmp = 0;
                if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
                else cmp = String(va).localeCompare(String(vb));
                return this.sortDir === 'asc' ? cmp : -cmp;
            });
        }
        return rows;
    }

    render() {
        const container = document.getElementById(this.containerId);
        if (!container) return;
        const filtered = this.getFilteredData();
        const totalPages = Math.max(1, Math.ceil(filtered.length / this.pageSize));
        if (this.page >= totalPages) this.page = totalPages - 1;
        const start = this.page * this.pageSize;
        const pageData = filtered.slice(start, start + this.pageSize);
        const end = Math.min(start + this.pageSize, filtered.length);

        let html = '<div class="dt-wrapper">';
        html += '<div class="dt-toolbar">';
        html += `<input class="dt-search" type="text" placeholder="Search..." value="${this.escHtml(this.searchText)}" data-dt="${this.containerId}" onkeyup="dtInstances['${this.containerId}'].onSearch(this.value)">`;
        html += `<div class="dt-info">${filtered.length === 0 ? 'No results' : `${start + 1}-${end} of ${filtered.length}`}</div>`;
        html += '</div>';

        html += '<table><thead><tr>';
        this.columns.forEach((col, i) => {
            const sortClass = this.sortCol === i ? (this.sortDir === 'asc' ? 'sort-asc' : 'sort-desc') : '';
            html += `<th class="${sortClass}" onclick="dtInstances['${this.containerId}'].onSort(${i})">${col.label}<span class="sort-icon"></span></th>`;
        });
        html += '</tr></thead><tbody>';
        if (pageData.length === 0) {
            html += `<tr><td colspan="${this.columns.length}" style="text-align:center;color:var(--gray-400);padding:2rem">No matching records</td></tr>`;
        }
        for (const row of pageData) {
            const clickAttr = this.onRowClick ? `class="clickable" onclick="dtInstances['${this.containerId}'].rowClick(${JSON.stringify(row._dtId || '').replace(/"/g, '&quot;')})"` : '';
            html += `<tr ${clickAttr}>`;
            for (const col of this.columns) {
                const val = col.render ? col.render(row) : this.escHtml(row[col.key] ?? '');
                html += `<td>${val}</td>`;
            }
            html += '</tr>';
        }
        html += '</tbody></table>';

        if (totalPages > 1) {
            html += '<div class="dt-toolbar" style="justify-content:flex-end"><div class="dt-pagination">';
            html += `<button ${this.page === 0 ? 'disabled' : ''} onclick="dtInstances['${this.containerId}'].goPage(${this.page - 1})">Prev</button>`;
            for (let i = 0; i < totalPages; i++) {
                if (totalPages > 7 && i > 1 && i < totalPages - 2 && Math.abs(i - this.page) > 1) {
                    if (i === 2 || i === totalPages - 3) html += '<span style="padding:0 0.25rem;color:var(--gray-400)">...</span>';
                    continue;
                }
                html += `<button class="${i === this.page ? 'active' : ''}" onclick="dtInstances['${this.containerId}'].goPage(${i})">${i + 1}</button>`;
            }
            html += `<button ${this.page >= totalPages - 1 ? 'disabled' : ''} onclick="dtInstances['${this.containerId}'].goPage(${this.page + 1})">Next</button>`;
            html += '</div></div>';
        }
        html += '</div>';
        container.innerHTML = html;
    }

    onSearch(val) { this.searchText = val; this.page = 0; this.render(); }
    onSort(colIdx) {
        if (this.sortCol === colIdx) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        else { this.sortCol = colIdx; this.sortDir = 'asc'; }
        this.render();
    }
    goPage(p) { this.page = p; this.render(); }
    rowClick(id) { if (this.onRowClick) this.onRowClick(id); }
    escHtml(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
}

const dtInstances = {};
function createDT(id, config) {
    config.data.forEach((row, i) => { row._dtId = row._dtId || String(i); });
    const dt = new DataTable(id, config);
    dtInstances[id] = dt;
    return dt;
}


// ── Data helpers ───────────────────────────────────────────────────────────
function getProjectById(id) {
    return (data.projects || []).find(p => p.id === id);
}

function getCareSetsForProject(projId) {
    return (data.caresets || []).filter(cs => cs.project === projId);
}

function getAllCareSets() {
    const results = [];
    for (const cs of (data.caresets || [])) {
        const proj = getProjectById(cs.project);
        if (!proj) continue;
        const current = getCurrentDelivery(cs);
        results.push({ project: proj, careset: cs, delivery: current, _dtId: `${proj.id}|${cs.id}` });
    }
    return results;
}

function getCurrentDelivery(cs) {
    if (!cs.deliveries || cs.deliveries.length === 0) return null;
    return cs.deliveries.find(d => d.current) || cs.deliveries[cs.deliveries.length - 1];
}

function aggregateStatus(packages) {
    if (!packages || packages.length === 0) return 'planned';
    const statuses = packages.map(p => p.status);
    if (statuses.every(s => s === 'published')) return 'published';
    if (statuses.some(s => s === 'published' || s === 'approved')) return 'approved';
    if (statuses.some(s => s === 'review')) return 'review';
    if (statuses.some(s => s === 'draft')) return 'draft';
    if (statuses.some(s => s === 'wip')) return 'wip';
    return 'planned';
}

function getL2Status(delivery) { return delivery ? aggregateStatus(delivery.l2) : 'planned'; }
function getTStatus(delivery)  { return delivery ? aggregateStatus(delivery.t)  : 'planned'; }
function getL3Status(delivery) { return delivery ? aggregateStatus(delivery.l3) : 'planned'; }

function getDocStatus(delivery) {
    if (!delivery || !delivery.document) return 'planned';
    return delivery.document.status || 'planned';
}

function getAllArtifacts() {
    const results = [];
    for (const cs of (data.caresets || [])) {
        const proj = getProjectById(cs.project);
        if (!proj) continue;
        const delivery = getCurrentDelivery(cs);
        if (!delivery) continue;
        for (const pkg of (delivery.l2 || [])) {
            for (const art of (pkg.artifacts || [])) {
                results.push({ project: proj, careset: cs, delivery, pkg, layer: 'L2', artifact: art });
            }
        }
        for (const pkg of (delivery.t || [])) {
            for (const art of (pkg.artifacts || [])) {
                results.push({ project: proj, careset: cs, delivery, pkg, layer: 'T', artifact: art });
            }
        }
        for (const pkg of (delivery.l3 || [])) {
            for (const art of (pkg.artifacts || [])) {
                results.push({ project: proj, careset: cs, delivery, pkg, layer: 'L3', artifact: art });
            }
        }
    }
    for (const proj of (data.projects || [])) {
        for (const art of (proj.artifacts || [])) {
            const layer = art.layer || (['logical-model','business-rule'].includes(art.type) ? 'L2' : ['valueset','codesystem','namingsystem'].includes(art.type) ? 'T' : 'L3');
            results.push({ project: proj, careset: null, delivery: null, pkg: null, layer, artifact: art });
        }
    }
    return results;
}

// wip = active work/WG meetings, no formal draft yet (comes before 'draft' which
// implies a formal draft artifact exists).
const STATUS_ORDER = { planned: 0, wip: 1, draft: 2, review: 3, approved: 4, published: 5, deprecated: 6 };
function badge(status) { return `<span class="badge badge-${status || 'planned'}">${status || 'planned'}</span>`; }
function daysBetween(d1, d2) {
    if (!d1 || !d2) return null;
    return Math.round((new Date(d2) - new Date(d1)) / 86400000);
}
function delayChip(days) {
    if (days === null) return '<span class="delay-chip delay-na">pending</span>';
    if (days <= 14) return `<span class="delay-chip delay-ok">${days}d</span>`;
    if (days <= 45) return `<span class="delay-chip delay-warn">${days}d</span>`;
    return `<span class="delay-chip delay-bad">${days}d</span>`;
}
function formatDate(d) {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Returns a package delivery's published date. Prefers the explicit
// publishedDate field on the delivery entry; falls back to the matching
// version's date in packages.yaml allVersions (the ehealth publication date).
function getPkgPublishedDate(pkg) {
    if (!pkg) return null;
    if (pkg.publishedDate) return pkg.publishedDate;
    const pkgInfo = data.packages && data.packages[pkg.package];
    if (!pkgInfo || !pkgInfo.allVersions) return null;
    const match = pkgInfo.allVersions.find(v => v.version === pkg.version);
    return match ? match.date : null;
}
const getL3PublishedDate = getPkgPublishedDate;

function pipelineStage(delivery) {
    // Derives pipeline stage from artifact-aggregate statuses:
    //   4 = Technical fully published on ehealth
    //   3 = Technical approved (delivered by WG) but not fully published yet
    //   2 = Functional delivered (approved/published) but Technical not yet
    //   1 = In progress (document approved/published OR any wip/draft/review work)
    //   0 = Not started
    if (!delivery) return 0;
    const l3Status = getL3Status(delivery);
    if (l3Status === 'published') return 4;
    if (l3Status === 'approved') return 3;
    const l2Status = getL2Status(delivery);
    if (l2Status === 'approved' || l2Status === 'published') return 2;
    const docApproved = delivery.document && (delivery.document.date || delivery.document.status === 'approved' || delivery.document.status === 'published');
    const anyInProgress = ['wip','draft','review'].includes(l2Status) || ['wip','draft','review'].includes(l3Status) || ['wip','draft','review'].includes(getTStatus(delivery));
    if (docApproved || anyInProgress) return 1;
    return 0;
}
function pipelineBar(stage) {
    const pct = [0, 25, 50, 75, 100][stage] || 0;
    const cls = ['', 'pipeline-doc', 'pipeline-l2', 'pipeline-l3', 'pipeline-pub'][stage] || '';
    return `<div class="pipeline-bar"><div class="pipeline-segment ${cls}" style="width:${pct}%"></div></div>`;
}

function lookupPackageName(repo) {
    if (data.packages) {
        for (const [name, info] of Object.entries(data.packages)) {
            if (info.repository === repo) return name;
        }
    }
    const repoName = repo ? repo.split('/').pop() : '';
    return repoName ? `hl7.fhir.be.${repoName}` : null;
}

// Given a package name, return the IG (project) name that ships it, falling back
// to the package short name when no matching project is registered in be.yaml.
function lookupIGName(packageName) {
    if (!packageName) return null;
    for (const proj of (data.projects || [])) {
        if ((proj.packages || []).includes(packageName)) return proj.name;
    }
    // Try mapping by repository naming convention as a fallback
    const pkgInfo = (data.packages || {})[packageName];
    if (pkgInfo && pkgInfo.repository) {
        for (const proj of (data.projects || [])) {
            if (proj.repository === pkgInfo.repository) return proj.name;
        }
    }
    return packageName.replace(/^hl7\.fhir\.\w+\./, '');
}

function lookupPackageInfo(packageName) {
    return (data.packages && data.packages[packageName]) || null;
}

function toggleExp(header) {
    header.querySelector('.exp-toggle').classList.toggle('open');
    header.nextElementSibling.classList.toggle('open');
}


// ═══════════════════════════════════════════════════════════════════════════
// EXPLORER — Package-centric: Package > Artifacts by layer
// Project/CareSet are annotations, not hierarchy levels.
// ═══════════════════════════════════════════════════════════════════════════

// Maps a FHIR artifact type to the layer it belongs in.
// Used as a sanity check when YAML places artifacts in the wrong layer array.
function layerForType(type) {
    if (!type) return null;
    if (['logical-model', 'business-rule', 'data-dictionary', 'decision-logic'].includes(type)) return 'L2';
    if (['valueset', 'codesystem', 'namingsystem', 'conceptmap', 'termcapabilities'].includes(type)) return 'T';
    // Technical-layer conformance resources (not just profiles/extensions)
    if (['profile', 'extension', 'operation', 'searchparam', 'capability', 'ig',
         'message', 'questionnaire', 'structuremap', 'graph', 'compartment'].includes(type)) return 'L3';
    return null;
}

const _warnedMisplacements = new Set();
function warnMisplaced(pkgName, artId, artType, placed, should) {
    const key = `${pkgName}|${artId}`;
    if (_warnedMisplacements.has(key)) return;
    _warnedMisplacements.add(key);
    console.warn(`be.yaml: artifact '${artId}' (type=${artType}) in ${pkgName} is under ${placed} but belongs under ${should}. Auto-reclassified.`);
}

function getPackageArtifacts() {
    // Collect all artifacts per package, flat (no project hierarchy)
    const pkgMap = {}; // pkgName -> { info, artifacts: [...], layers, projects }

    for (const [pkgName, pkgInfo] of Object.entries(data.packages || {})) {
        pkgMap[pkgName] = { name: pkgName, info: pkgInfo, artifacts: [], layers: new Set(), projects: new Set() };
    }

    function ensurePkg(pkgName) {
        if (!pkgMap[pkgName]) {
            pkgMap[pkgName] = { name: pkgName, info: null, artifacts: [], layers: new Set(), projects: new Set() };
        }
    }

    for (const proj of (data.projects || [])) {
        // Project-level artifacts
        for (const art of (proj.artifacts || [])) {
            const pkgName = art.package || lookupPackageName(proj.repository);
            if (!pkgName) continue;
            ensurePkg(pkgName);
            const layer = art.layer || (['logical-model','business-rule'].includes(art.type) ? 'L2' : ['valueset','codesystem','namingsystem'].includes(art.type) ? 'T' : 'L3');
            pkgMap[pkgName].artifacts.push({ ...art, layer, projectName: proj.name, caresetName: null, version: null });
            pkgMap[pkgName].layers.add(layer);
            pkgMap[pkgName].projects.add(proj.name);
        }

        // CareSet delivery artifacts — ALL deliveries, not just current
        for (const cs of getCareSetsForProject(proj.id)) {
            for (const delivery of (cs.deliveries || [])) {
                const addArts = (pkgs, layer) => {
                    for (const pkg of (pkgs || [])) {
                        const pkgName = pkg.package || lookupPackageName(proj.repository);
                        if (!pkgName) continue;
                        ensurePkg(pkgName);
                        for (const art of (pkg.artifacts || [])) {
                            // Sanity check: if the artifact type implies a different layer
                            // (e.g. a valueset mistakenly listed under l2), reclassify it
                            // and warn once. This keeps the UI correct even when the YAML
                            // places artifacts in the wrong layer array.
                            const effectiveLayer = layerForType(art.type) || layer;
                            if (effectiveLayer !== layer) {
                                warnMisplaced(pkgName, art.id, art.type, layer, effectiveLayer);
                            }
                            pkgMap[pkgName].artifacts.push({
                                ...art, layer: effectiveLayer, projectName: proj.name, caresetName: cs.name,
                                version: pkg.version, isCurrent: delivery.current || false
                            });
                            pkgMap[pkgName].layers.add(effectiveLayer);
                            pkgMap[pkgName].projects.add(proj.name);
                        }
                    }
                };
                addArts(delivery.l2, 'L2');
                addArts(delivery.t, 'T');
                addArts(delivery.l3, 'L3');
            }
        }
    }

    // Fallback: for packages that have no careset-linked artifacts but DO have
    // a crawled artifact list attached (via main.js after a crawl), include those.
    for (const [pkgName, info] of Object.entries(data.packages || {})) {
        if (!info || !info.artifacts || info.artifacts.length === 0) continue;
        if (pkgMap[pkgName] && pkgMap[pkgName].artifacts.length > 0) continue;
        ensurePkg(pkgName);
        for (const art of info.artifacts) {
            const layer = art.layer || (['logical-model','business-rule'].includes(art.type) ? 'L2' : ['valueset','codesystem','namingsystem'].includes(art.type) ? 'T' : 'L3');
            pkgMap[pkgName].artifacts.push({
                ...art, layer, projectName: null, caresetName: null,
                version: info.currentVersion, isCurrent: true
            });
            pkgMap[pkgName].layers.add(layer);
        }
    }

    // Deduplicate & collect versions: group by id|type, keep canonical ID, collect all versions
    for (const pkg of Object.values(pkgMap)) {
        const seen = new Map(); // key -> { art (best), versions: [{version, status, isCurrent}] }
        for (const art of pkg.artifacts) {
            const key = `${(art.id || '').toLowerCase()}|${art.type}`;
            const entry = seen.get(key);
            if (!entry) {
                seen.set(key, { art, versions: art.version ? [{ version: art.version, status: art.status, isCurrent: art.isCurrent }] : [] });
            } else {
                // Prefer the one with canonical ID (project-level), or the current delivery
                if (art.version) {
                    // Add version if not already present
                    if (!entry.versions.some(v => v.version === art.version)) {
                        entry.versions.push({ version: art.version, status: art.status, isCurrent: art.isCurrent });
                    }
                }
                // Keep canonical ID from project-level entry
                if (!art.version && art.id && art.id !== art.id.toLowerCase()) {
                    entry.art = { ...entry.art, id: art.id, name: art.name || entry.art.name };
                }
                // Prefer current delivery as the main entry
                if (art.isCurrent && art.version) {
                    entry.art = { ...art, id: entry.art.id || art.id, name: entry.art.name || art.name };
                }
            }
        }
        // Sort versions descending, attach to artifact
        pkg.artifacts = [...seen.values()].map(e => {
            e.versions.sort((a, b) => (b.version || '').localeCompare(a.version || ''));
            const anyCurrent = e.versions.some(v => v.isCurrent);
            const lastVersion = e.versions[0] ? e.versions[0].version : null;
            return { ...e.art, versions: e.versions, isCurrent: anyCurrent, lastVersion };
        });
    }

    return Object.values(pkgMap)
        .filter(p => p.artifacts.length > 0 || p.info)
        .sort((a, b) => {
            // Packages with artifacts first, registry-only packages after
            const aEmpty = a.artifacts.length === 0;
            const bEmpty = b.artifacts.length === 0;
            if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
            return a.name.localeCompare(b.name);
        });
}

function setExplorerMode(mode) {
    explorerMode = mode;
    renderExplorer();
}

function toggleHistoricalArtifacts(el) {
    showHistoricalArtifacts = !!el.checked;
    renderExplorer();
}

function toggleShowBranches(el) {
    showBranches = !!el.checked;
    renderTimelineInteractive();
}

const layerDefs = [
    { key: 'L2', label: 'Functional — Models', color: 'var(--purple)' },
    { key: 'T', label: 'Terminology', color: 'var(--teal)' },
    { key: 'L3', label: 'Technical — Profiles', color: 'var(--primary)' }
];

function renderExplorer() {
    const packages = getPackageArtifacts();
    const allCS = getAllCareSets();
    const allArts = getAllArtifacts();
    const publishedCS = allCS.filter(r => r.careset.status === 'published').length;
    const totalPkgs = Object.keys(data.packages || {}).length;

    artVerCounter = 0;
    const m = explorerMode;
    const card = (mode, value, label, color) =>
        `<div class="stat-card${m === mode ? ' stat-card-active' : ''}" onclick="setExplorerMode('${mode}')" style="cursor:pointer">
            <div class="stat-value"${color ? ` style="color:${color}"` : ''}>${value}</div>
            <div class="stat-label">${label}</div>
        </div>`;

    let html = `<div class="stats-row">
        ${card('packages', totalPkgs, 'Packages')}
        ${card('projects', (data.projects || []).length, 'Projects')}
        ${card('caresets', allCS.length, 'CareSets')}
        ${card('published', publishedCS, 'Published', 'var(--success)')}
        ${card('artifacts', allArts.length, 'Artifacts')}
    </div>`;

    if (m === 'packages' || m === 'projects') {
        html += `<div style="display:flex;gap:0.75rem;align-items:center;margin-bottom:0.75rem;font-size:0.8125rem;color:var(--gray-600)">
            <label style="display:flex;gap:0.375rem;align-items:center;cursor:pointer">
                <input type="checkbox" ${showHistoricalArtifacts ? 'checked' : ''} onchange="toggleHistoricalArtifacts(this)">
                Show artifacts from older releases
            </label>
        </div>`;
    }
    if (m === 'packages') html += renderExplorerPackages(packages);
    else if (m === 'projects') html += renderExplorerProjects(packages);
    else if (m === 'caresets') html += renderExplorerCareSets(allCS);
    else if (m === 'published') html += renderExplorerPublished(allCS);
    else if (m === 'artifacts') html += renderExplorerArtifacts(allArts);

    document.getElementById('viewContent').innerHTML = html;
}

// ── Packages sub-view (default) ──
// Maps internal layer codes (L2/T/L3) to content-type labels: short for badges,
// long for tooltips / other views.
const CONTENT_LABELS = { L2: 'Functional', T: 'Terminology', L3: 'Technical' };
const CONTENT_SHORT  = { L2: 'Funct',      T: 'Term',        L3: 'Tech' };
const CONTENT_ORDER = ['L2', 'T', 'L3'];
function renderExplorerPackages(packages) {
    let html = '';
    for (const pkg of packages) {
        const pi = pkg.info;
        const layers = [...pkg.layers];
        // Build content-type badges in a fixed order (Functional → Terminology → Technical)
        const contentBadges = CONTENT_ORDER
            .filter(k => layers.includes(k))
            .map(k => `<span class="badge badge-${CONTENT_LABELS[k].toLowerCase()}" style="font-size:0.5625rem" title="${CONTENT_LABELS[k]}">${CONTENT_SHORT[k]}</span>`)
            .join(' ');
        const projList = [...pkg.projects].sort().join(', ');

        const allVers = (pi && pi.allVersions) || [];
        const curVer = (pi && pi.currentVersion) || '';
        const olderVers = allVers.filter(v => v.version !== curVer);
        const verExpandId = `pkg-ver-${pkg.name.replace(/\./g, '-')}`;
        const hasRelease = !!curVer || allVers.length > 0;

        // Version group: either "unreleased" chip, or v{curVer} + optional +N
        const versionGroup = !hasRelease
            ? `<span class="badge badge-unreleased" style="font-size:0.5625rem" title="No release yet">unreleased</span>`
            : `${curVer ? `<span class="badge badge-published" style="font-size:0.5625rem">v${curVer}</span>` : ''}
               ${olderVers.length > 0 ? `<span class="ver-toggle" onclick="event.stopPropagation();toggleVersions('${verExpandId}', this)" title="${allVers.length} versions">+${olderVers.length}</span>` : ''}`;

        html += `<div class="exp-node">
            <div class="exp-header" onclick="toggleExp(this)">
                <svg class="exp-toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                <span class="exp-name">${pkg.name}</span>
                <span style="display:inline-flex;gap:0.25rem;margin-left:0.5rem">${contentBadges}</span>
                <span style="display:inline-flex;gap:0.25rem;align-items:center;margin-left:1.25rem">${versionGroup}</span>
                ${pi && pi.source === 'registry' ? `<span class="badge" style="font-size:0.5625rem;margin-left:0.5rem;background:var(--teal-light);color:var(--teal)" title="From registry: ${pi.sourceName || 'external'}">registry</span>` : ''}
                <span class="exp-meta">
                    ${pkg.artifacts.length} artifacts
                    ${pi && pi.igUrl ? `<a href="${pi.igUrl}" target="_blank" onclick="event.stopPropagation()" style="color:var(--primary);font-size:0.75rem">CI</a>` : ''}
                    ${pi && pi.publicationUrl ? `<a href="${pi.publicationUrl}" target="_blank" onclick="event.stopPropagation()" style="color:var(--primary);font-size:0.75rem">Pub</a>` : ''}
                    ${pi && pi.repository ? `<a href="https://github.com/${pi.repository}" target="_blank" onclick="event.stopPropagation()" style="color:var(--primary);font-size:0.75rem">GitHub</a>` : ''}
                </span>
            </div>
            <div class="exp-children">`;

        // Version history (expandable)
        if (olderVers.length > 0) {
            html += `<div id="${verExpandId}" class="ver-list" style="display:none;margin-left:0.5rem;margin-bottom:0.5rem">
                ${allVers.map(v => {
                    const vUrl = pi && pi.publicationUrl ? `${pi.publicationUrl}/${v.version}` : null;
                    return `<div class="ver-row">
                        <span class="badge badge-published" style="font-size:0.5625rem">v${v.version}</span>
                        <span style="font-size:0.75rem;color:var(--gray-500)">${v.date ? v.date.substring(0, 10) : ''}</span>
                        ${v.version === curVer ? '<span style="font-size:0.625rem;color:var(--success)">(current)</span>' : ''}
                        ${vUrl ? `<a href="${vUrl}" target="_blank" style="font-size:0.75rem;color:var(--primary)">open</a>` : ''}
                    </div>`;
                }).join('')}
            </div>`;
        }

        if (pkg.projects.size > 0) {
            html += `<div style="font-size:0.75rem;color:var(--gray-400);margin-bottom:0.5rem">Projects: ${projList}</div>`;
        }

        for (const ld of layerDefs) {
            let arts = pkg.artifacts.filter(a => a.layer === ld.key);
            // By default hide artifacts that don't appear in any current delivery
            // (e.g. renamed between releases). Toggle via "Show older releases" checkbox.
            if (!showHistoricalArtifacts) arts = arts.filter(a => a.isCurrent);
            if (arts.length === 0) continue;
            html += `<div class="exp-layer-header" style="color:${ld.color}">${ld.label} <span style="color:var(--gray-400)">(${arts.length})</span></div>`;
            for (const art of arts) {
                html += renderArtifactRow(art, pi);
            }
        }

        // Fallback body for packages with no artifacts loaded (registry-only,
        // or explicit entries whose artifacts haven't been crawled yet).
        if (pkg.artifacts.length === 0) {
            const latest = allVers[0];
            const sourceHint = pi && pi.source === 'registry'
                ? `Discovered via registry: <strong>${pi.sourceName || 'external'}</strong>.`
                : `Listed in <code>packages.yaml</code>.`;
            html += `<div style="padding:0.5rem 0;font-size:0.8125rem;color:var(--gray-600)">
                ${!hasRelease
                    ? `<div style="margin-bottom:0.5rem"><strong>No released version yet.</strong> ${sourceHint}</div>`
                    : `<div style="margin-bottom:0.5rem">${sourceHint} Latest: <strong>v${curVer}</strong>${latest && latest.date ? ` (${formatDate(latest.date)})` : ''}.</div>`}
                <div style="color:var(--gray-500)">No artifacts loaded. Open <a href="#" onclick="event.preventDefault();event.stopPropagation();switchView('crawl')" style="color:var(--primary)">Crawl</a> to fetch them from the FHIR registry.</div>
            </div>`;
        }

        html += '</div></div>';
    }
    return html;
}

// ── Projects sub-view ──
function renderExplorerProjects(packages) {
    // Group artifacts by project
    const projMap = {};
    for (const pkg of packages) {
        for (const art of pkg.artifacts) {
            const pn = art.projectName || 'Unassigned';
            if (!projMap[pn]) projMap[pn] = { name: pn, artifacts: [], packages: new Set() };
            projMap[pn].artifacts.push({ ...art, packageName: pkg.name, packageInfo: pkg.info });
            projMap[pn].packages.add(pkg.name);
        }
    }
    const projects = Object.values(projMap).sort((a, b) => a.name.localeCompare(b.name));

    let html = '';
    for (const proj of projects) {
        const pkgList = [...proj.packages].sort().join(', ');
        // Collect package versions for this project
        const pkgVersions = [...proj.packages].map(pn => {
            const pi = (data.packages || {})[pn];
            return pi && pi.currentVersion ? `${pn.replace('hl7.fhir.be.', '')} v${pi.currentVersion}` : null;
        }).filter(Boolean).join(', ');

        html += `<div class="exp-node">
            <div class="exp-header" onclick="toggleExp(this)">
                <svg class="exp-toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                <span class="exp-name">${proj.name}</span>
                <span class="exp-meta">${proj.artifacts.length} artifacts &middot; ${proj.packages.size} package${proj.packages.size > 1 ? 's' : ''}</span>
            </div>
            <div class="exp-children">`;

        html += `<div style="font-size:0.75rem;color:var(--gray-400);margin-bottom:0.5rem">Packages: ${pkgVersions || pkgList}</div>`;

        // Project proposals
        const projData = (data.projects || []).find(p => p.name === proj.name);
        if (projData && projData.proposals && projData.proposals.length > 0) {
            html += renderDocumentList('Project Proposals', projData.proposals);
        }

        for (const ld of layerDefs) {
            const arts = proj.artifacts.filter(a => a.layer === ld.key);
            if (arts.length === 0) continue;
            html += `<div class="exp-layer-header" style="color:${ld.color}">${ld.label} <span style="color:var(--gray-400)">(${arts.length})</span></div>`;
            for (const art of arts) {
                html += renderArtifactRow(art, art.packageInfo, art.packageName);
            }
        }

        html += '</div></div>';
    }
    return html;
}

// ── CareSets sub-view ──
function renderExplorerCareSets(allCS) {
    let html = '';
    const sorted = [...allCS].sort((a, b) => a.careset.name.localeCompare(b.careset.name));
    for (const r of sorted) {
        const cs = r.careset;
        const del = r.delivery;
        const statusBadge = `<span class="badge badge-${cs.status || 'planned'}">${cs.status || 'planned'}</span>`;
        const artCount = del ? ['l2','t','l3'].reduce((n, layer) => n + (del[layer] || []).reduce((s, p) => s + (p.artifacts || []).length, 0), 0) : 0;

        const synthChip = cs.source === 'synth'
            ? `<span class="badge" style="background:var(--teal-light);color:var(--teal);font-size:0.625rem" title="Auto-registered from ${cs.sourceOrigin === 'registry' ? 'package registry' : 'packages.yaml'} — promote to a full careset by adding it to be.yaml">auto</span>`
            : '';
        html += `<div class="exp-node">
            <div class="exp-header" onclick="toggleExp(this)">
                <svg class="exp-toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                <span class="exp-name">${cs.name}</span>
                ${statusBadge}
                ${synthChip}
                <span class="exp-meta">${r.project.name} &middot; ${artCount} artifacts</span>
            </div>
            <div class="exp-children">`;

        if (del) {
            // Business documents
            if (del.businessDocuments && del.businessDocuments.length > 0) {
                html += renderDocumentList('Business Documents', del.businessDocuments);
            }
            for (const ld of layerDefs) {
                const layerKey = ld.key.toLowerCase() === 't' ? 't' : ld.key.toLowerCase();
                const pkgs = del[layerKey] || [];
                const arts = pkgs.flatMap(p => (p.artifacts || []).map(a => ({ ...a, version: p.version, status: a.status || p.status })));
                if (arts.length === 0) continue;
                const pi = pkgs[0] && pkgs[0].package ? (data.packages || {})[pkgs[0].package] : null;
                html += `<div class="exp-layer-header" style="color:${ld.color}">${ld.label} <span style="color:var(--gray-400)">(${arts.length})</span></div>`;
                for (const art of arts) {
                    html += renderArtifactRow(art, pi);
                }
            }
        } else {
            html += `<div style="font-size:0.75rem;color:var(--gray-400)">No delivery data</div>`;
        }

        html += '</div></div>';
    }
    return html;
}

// ── Published sub-view ──
function renderExplorerPublished(allCS) {
    const published = allCS.filter(r => r.careset.status === 'published');
    if (published.length === 0) return '<div style="color:var(--gray-400);padding:1rem">No published caresets</div>';
    return renderExplorerCareSets(published);
}

// ── Flat artifacts sub-view (DataTable) ──
function renderExplorerArtifacts(allArts) {
    const rows = allArts.map(r => ({
        name: r.artifact.name || r.artifact.id || '?',
        id: r.artifact.id || '',
        type: r.artifact.type || '',
        layer: r.layer || '',
        version: r.pkg ? r.pkg.version || '' : '',
        status: r.artifact.status || r.pkg?.status || 'planned',
        project: r.project.name || '',
        careset: r.careset ? r.careset.name : '',
        package: r.pkg ? r.pkg.package || '' : (r.artifact.package || ''),
        _pi: r.pkg && r.pkg.package ? (data.packages || {})[r.pkg.package] : null,
        _art: r.artifact
    }));

    // Return a container div; DataTable will fill it after innerHTML is set
    setTimeout(() => {
        createDT('artifactsTable', {
            data: rows,
            defaultSort: 0,
            pageSize: 20,
            columns: [
                { key: 'name', label: 'Name', render: r => {
                    const artResType = ['logical-model','profile','extension'].includes(r.type) ? 'StructureDefinition' : (r.type === 'valueset' ? 'ValueSet' : r.type === 'codesystem' ? 'CodeSystem' : r.type === 'namingsystem' ? 'NamingSystem' : null);
                    const url = (r._pi && r._pi.publicationUrl && artResType && r.id) ? `${r._pi.publicationUrl}/${artResType}/${r.id}` : null;
                    return url ? `<a href="${url}" target="_blank">${r.name}</a>` : r.name;
                }},
                { key: 'type', label: 'Type' },
                { key: 'layer', label: 'Layer', render: r => r.layer ? `<span class="badge badge-${r.layer.toLowerCase()}">${r.layer}</span>` : '' },
                { key: 'version', label: 'Version', render: r => r.version ? `<span class="badge badge-${r.status}" style="font-size:0.625rem">v${r.version}</span>` : '' },
                { key: 'project', label: 'Project' },
                { key: 'careset', label: 'CareSet' },
                { key: 'package', label: 'Package' }
            ]
        });
    }, 0);

    return '<div id="artifactsTable"></div>';
}

// ── Document list renderer ──
function renderDocumentList(title, docs) {
    if (!docs || docs.length === 0) return '';
    let html = `<div style="margin:0.5rem 0">
        <div style="font-size:0.75rem;font-weight:600;color:var(--gray-500);margin-bottom:0.25rem">${title}</div>`;
    for (const doc of docs) {
        const fileLink = doc.file ? `<a href="${doc.file}" download style="font-size:0.75rem;color:var(--primary);text-decoration:none;border-bottom:1px dashed var(--gray-300)">download</a>` : '';
        const statusBadge = doc.status ? `<span class="badge badge-${doc.status}" style="font-size:0.5625rem">${doc.status}</span>` : '';
        html += `<div class="exp-art-row">
            ${statusBadge}
            <span style="color:var(--gray-800);font-size:0.8125rem">${doc.title || doc.file || 'Untitled'}</span>
            ${doc.version ? `<span style="color:var(--gray-400);font-size:0.75rem">v${doc.version}</span>` : ''}
            ${doc.date ? `<span style="color:var(--gray-400);font-size:0.75rem">${doc.date}</span>` : ''}
            ${fileLink}
        </div>`;
    }
    html += '</div>';
    return html;
}

let artVerCounter = 0;

function renderArtifactRow(art, packageInfo, packageLabel) {
    const artResType = ['logical-model','profile','extension'].includes(art.type) ? 'StructureDefinition' : (art.type === 'valueset' ? 'ValueSet' : art.type === 'codesystem' ? 'CodeSystem' : art.type === 'namingsystem' ? 'NamingSystem' : null);
    const pubBase = packageInfo && packageInfo.publicationUrl;
    const artUrl = (pubBase && artResType && art.id) ? `${pubBase}/${artResType}/${art.id}` : null;
    const origin = packageLabel || art.caresetName || '';

    // Artifact-specific version history (collected during dedup in getPackageArtifacts).
    // art.versions is [{version, status, isCurrent}] — only the versions this
    // artifact actually appears in, not the full package history.
    const artVers = (art.versions || []).filter(v => v.version);
    const currentVer = (artVers.find(v => v.isCurrent) || artVers[0] || {}).version || art.version || '';
    const olderVers = artVers.filter(v => v.version !== currentVer);
    const badgeText = currentVer ? 'v' + currentVer : '';
    const expandId = olderVers.length > 0 ? `art-ver-${++artVerCounter}` : '';
    const allVers = artVers;

    // If the artifact is NOT in any current delivery, it's historical — show a
    // muted "last seen" badge instead of the usual published-version badge.
    const isHistorical = !art.isCurrent;
    let html = `<div class="exp-art-row"${isHistorical ? ' style="opacity:0.7"' : ''}>`;
    if (isHistorical && art.lastVersion) {
        html += `<span class="badge" style="font-size:0.5625rem;background:var(--gray-200);color:var(--gray-600)" title="Last seen in v${art.lastVersion} — not in the current release">removed · last v${art.lastVersion}</span>`;
    } else if (badgeText) {
        html += `<span class="badge badge-published" style="font-size:0.5625rem">${badgeText}</span>`;
    }
    if (olderVers.length > 0) {
        html += `<span class="ver-toggle" onclick="toggleVersions('${expandId}', this)" title="${allVers.length} versions">+${olderVers.length}</span>`;
    }
    html += artUrl
        ? `<a class="exp-art-name" href="${artUrl}" target="_blank">${art.name || art.id || '?'}</a>`
        : `<span style="color:var(--gray-800)">${art.name || art.id || '?'}</span>`;
    html += `<span class="exp-art-type">${art.type}${art.fhirBase ? ': ' + art.fhirBase : ''}</span>`;
    if (origin) html += `<span style="color:var(--gray-400);font-size:0.6875rem;margin-left:auto">${origin}</span>`;
    html += `</div>`;

    // Expandable version history per artifact
    if (olderVers.length > 0) {
        html += `<div id="${expandId}" class="ver-list" style="display:none">`;
        for (const v of allVers) {
            const vUrl = (pubBase && artResType && art.id) ? `${pubBase}/${v.version}/${artResType}/${art.id}` : null;
            html += `<div class="ver-row">
                <span class="badge badge-published" style="font-size:0.5625rem">v${v.version}</span>
                <span style="font-size:0.75rem;color:var(--gray-500)">${v.date ? v.date.substring(0, 10) : ''}</span>
                ${v.version === currentVer ? '<span style="font-size:0.625rem;color:var(--success)">(current)</span>' : ''}
                ${vUrl ? `<a href="${vUrl}" target="_blank" style="font-size:0.75rem;color:var(--primary)">open</a>` : ''}
            </div>`;
        }
        html += '</div>';
    }

    return html;
}

function toggleVersions(id, el) {
    const list = document.getElementById(id);
    if (!list) return;
    const open = list.style.display !== 'none';
    list.style.display = open ? 'none' : 'block';
    el.textContent = open ? '+' + (list.children.length) : '−';
}


// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE — Active delivery tracking
// ═══════════════════════════════════════════════════════════════════════════

function hasPublishedDelivery(cs) {
    return (cs.deliveries || []).some(d => d.status === 'published');
}

function renderPipeline() {
    const all = getAllCareSets();
    const initiation = all.filter(r => !hasPublishedDelivery(r.careset));
    const iteration = all.filter(r => hasPublishedDelivery(r.careset));
    const iterActive = iteration.filter(r => r.delivery && r.delivery.status !== 'published');
    const iterStable = iteration.filter(r => !r.delivery || r.delivery.status === 'published');

    const stages = [
        { label: 'Not Started', filter: r => pipelineStage(r.delivery) === 0, color: 'var(--gray-400)' },
        { label: 'In Progress', filter: r => pipelineStage(r.delivery) === 1, color: 'var(--warning)' },
        { label: 'Functional Delivered', filter: r => pipelineStage(r.delivery) === 2, color: 'var(--purple)' },
        { label: 'Technical Delivered', filter: r => pipelineStage(r.delivery) === 3, color: 'var(--primary)' },
        { label: 'Published', filter: r => pipelineStage(r.delivery) === 4, color: 'var(--success)' }
    ];

    let html = '<div class="stats-row">';
    html += `<div class="stat-card"><div class="stat-value">${initiation.length}</div><div class="stat-label">Initiation</div></div>`;
    html += `<div class="stat-card"><div class="stat-value">${iterActive.length}</div><div class="stat-label">Active Sprints</div></div>`;
    html += `<div class="stat-card"><div class="stat-value" style="color:var(--success)">${iterStable.length}</div><div class="stat-label">Stable</div></div>`;
    html += `<div class="stat-card"><div class="stat-value">${all.length}</div><div class="stat-label">Total</div></div>`;
    html += '</div>';

    // Initiation
    if (initiation.length > 0) {
        html += '<h3 style="font-size:1rem;font-weight:600;margin:1.5rem 0 0.75rem;color:var(--gray-700)">Initiation Pipeline</h3>';
        html += '<p style="font-size:0.8125rem;color:var(--gray-500);margin-bottom:1rem">Working toward first published release</p>';
        html += '<div class="stats-row">';
        for (const s of stages) {
            html += `<div class="stat-card"><div class="stat-value" style="color:${s.color}">${initiation.filter(s.filter).length}</div><div class="stat-label" style="font-size:0.6875rem">${s.label}</div></div>`;
        }
        html += '</div>';
        stages.forEach((s, idx) => {
            const items = initiation.filter(s.filter);
            if (items.length === 0) return;
            html += `<div class="card"><div class="card-header" style="border-left:4px solid ${s.color}">${s.label} (${items.length})</div><div class="card-body"><div id="dt-init-${idx}"></div></div></div>`;
        });
    }

    // Active sprints
    if (iterActive.length > 0) {
        html += '<h3 style="font-size:1rem;font-weight:600;margin:1.5rem 0 0.75rem;color:var(--gray-700)">Sprint Pipeline</h3>';
        html += '<p style="font-size:0.8125rem;color:var(--gray-500);margin-bottom:1rem">Published, now working on next version</p>';
        stages.forEach((s, idx) => {
            const items = iterActive.filter(s.filter);
            if (items.length === 0) return;
            html += `<div class="card"><div class="card-header" style="border-left:4px solid ${s.color}">${s.label} (${items.length})</div><div class="card-body"><div id="dt-iter-${idx}"></div></div></div>`;
        });
    }

    // Stable
    if (iterStable.length > 0) {
        html += '<h3 style="font-size:1rem;font-weight:600;margin:1.5rem 0 0.75rem;color:var(--gray-700)">Stable</h3>';
        html += `<div class="card"><div class="card-header" style="border-left:4px solid var(--success)">Published (${iterStable.length})</div><div class="card-body"><div id="dt-stable"></div></div></div>`;
    }

    html += '<div id="drillTarget"></div>';
    document.getElementById('viewContent').innerHTML = html;

    const onCSClick = dtId => { const [p, c] = dtId.split('|'); drillCareSet(p, c); };

    const pipelineCols = [
        { key: 'project', label: 'Project', render: r => r.project.name, sortVal: r => r.project.name, searchVal: r => r.project.name },
        { key: 'cs', label: 'CareSet', render: r => `<strong>${r.careset.name}</strong>`, sortVal: r => r.careset.name, searchVal: r => r.careset.name },
        { key: 'v', label: 'Version', render: r => r.delivery ? r.delivery.version : '-' },
        { key: 'l2', label: 'Functional', render: r => badge(getL2Status(r.delivery)), sortVal: r => STATUS_ORDER[getL2Status(r.delivery)] || 0 },
        { key: 't', label: 'Terminology', render: r => badge(getTStatus(r.delivery)), sortVal: r => STATUS_ORDER[getTStatus(r.delivery)] || 0 },
        { key: 'l3', label: 'Technical', render: r => badge(getL3Status(r.delivery)), sortVal: r => STATUS_ORDER[getL3Status(r.delivery)] || 0 },
        { key: 'pipeline', label: 'Pipeline', render: r => pipelineBar(pipelineStage(r.delivery)), sortVal: r => pipelineStage(r.delivery) }
    ];

    const stableCols = [
        ...pipelineCols.slice(0, 3),
        { key: 'pub', label: 'Published', render: r => formatDate(r.delivery && r.delivery.l3 ? (r.delivery.l3.map(getL3PublishedDate).filter(Boolean)[0]) : null) },
        ...pipelineCols.slice(3, 6)
    ];

    if (initiation.length > 0) {
        stages.forEach((s, idx) => {
            const items = initiation.filter(s.filter);
            if (items.length > 0) createDT(`dt-init-${idx}`, { data: items, onRowClick: onCSClick, columns: pipelineCols });
        });
    }
    if (iterActive.length > 0) {
        stages.forEach((s, idx) => {
            const items = iterActive.filter(s.filter);
            if (items.length > 0) createDT(`dt-iter-${idx}`, { data: items, onRowClick: onCSClick, columns: pipelineCols });
        });
    }
    if (iterStable.length > 0) {
        createDT('dt-stable', { data: iterStable, defaultSort: 0, onRowClick: onCSClick, columns: stableCols });
    }
}


// ═══════════════════════════════════════════════════════════════════════════
// GAPS — Cross-cutting analysis
// ═══════════════════════════════════════════════════════════════════════════

function renderGaps() {
    const all = getAllCareSets();
    const gapCats = [
        { label: 'Functional Published, Technical Not Yet Started', filter: r => r.delivery && getL2Status(r.delivery) === 'published' && getL3Status(r.delivery) === 'planned', color: 'var(--danger)' },
        { label: 'Functional Published, Technical In Progress', filter: r => r.delivery && getL2Status(r.delivery) === 'published' && ['wip', 'draft', 'review'].includes(getL3Status(r.delivery)), color: 'var(--warning)' },
        { label: 'Technical Delivered, Awaiting Publication', filter: r => r.delivery && getL3Status(r.delivery) === 'approved', color: 'var(--primary)' },
        { label: 'Functional In Progress, Technical Not Started', filter: r => r.delivery && ['wip', 'draft', 'review'].includes(getL2Status(r.delivery)) && getL3Status(r.delivery) === 'planned', color: 'var(--gray-400)' },
        { label: 'Fully Published', filter: r => r.delivery && getL2Status(r.delivery) === 'published' && getL3Status(r.delivery) === 'published', color: 'var(--success)' }
    ];

    // Delays section
    const delayRows = all.filter(r => r.delivery && r.delivery.l3 && r.delivery.l3.length > 0).map(r => {
        const l3 = r.delivery.l3[0];
        const days = daysBetween(l3.deliveredDate, l3.publishedDate);
        const pending = l3.deliveredDate && !l3.publishedDate;
        const pendingDays = pending ? daysBetween(l3.deliveredDate, new Date().toISOString().split('T')[0]) : null;
        return { ...r, l3pkg: l3, days, pending, pendingDays, displayDays: pending ? pendingDays : days };
    });
    const pendingCount = delayRows.filter(r => r.pending).length;

    let html = '<div class="stats-row">';
    for (const c of gapCats) html += `<div class="stat-card"><div class="stat-value" style="color:${c.color}">${all.filter(c.filter).length}</div><div class="stat-label" style="font-size:0.6875rem">${c.label}</div></div>`;
    html += '</div>';

    gapCats.forEach((c, idx) => {
        const items = all.filter(c.filter);
        if (items.length === 0) return;
        html += `<div class="card"><div class="card-header" style="border-left:4px solid ${c.color}">${c.label} (${items.length})</div><div class="card-body"><div id="dt-gaps-${idx}"></div></div></div>`;
    });

    // Publication delays
    if (delayRows.length > 0) {
        html += '<h3 style="font-size:1rem;font-weight:600;margin:1.5rem 0 0.75rem;color:var(--gray-700)">Publication Delays</h3>';
        if (pendingCount > 0) html += `<p style="font-size:0.8125rem;color:var(--warning);margin-bottom:1rem">${pendingCount} awaiting federal publication</p>`;
        html += `<div class="card"><div class="card-header">Technical Delivery to Publication</div><div class="card-body"><div id="dt-delays"></div></div></div>`;
    }

    html += '<div id="drillTarget"></div>';
    document.getElementById('viewContent').innerHTML = html;

    const onCSClick = dtId => { const [p, c] = dtId.split('|'); drillCareSet(p, c); };

    gapCats.forEach((c, idx) => {
        const items = all.filter(c.filter);
        if (items.length === 0) return;
        createDT(`dt-gaps-${idx}`, {
            data: items, onRowClick: onCSClick,
            columns: [
                { key: 'project', label: 'Project', render: r => r.project.name, sortVal: r => r.project.name, searchVal: r => r.project.name },
                { key: 'cs', label: 'CareSet', render: r => `<strong>${r.careset.name}</strong>`, sortVal: r => r.careset.name, searchVal: r => r.careset.name },
                { key: 'v', label: 'Version', render: r => r.delivery ? r.delivery.version : '-' },
                { key: 'l2', label: 'Functional', render: r => badge(getL2Status(r.delivery)), sortVal: r => STATUS_ORDER[getL2Status(r.delivery)] || 0 },
                { key: 't', label: 'Terminology', render: r => badge(getTStatus(r.delivery)), sortVal: r => STATUS_ORDER[getTStatus(r.delivery)] || 0 },
                { key: 'l3', label: 'Technical', render: r => badge(getL3Status(r.delivery)), sortVal: r => STATUS_ORDER[getL3Status(r.delivery)] || 0 }
            ]
        });
    });

    if (delayRows.length > 0) {
        createDT('dt-delays', {
            data: delayRows, defaultSort: 5, defaultSortDir: 'desc', onRowClick: onCSClick,
            columns: [
                { key: 'project', label: 'Project', render: r => r.project.name, sortVal: r => r.project.name, searchVal: r => r.project.name },
                { key: 'cs', label: 'CareSet', render: r => `<strong>${r.careset.name}</strong>`, sortVal: r => r.careset.name, searchVal: r => r.careset.name },
                { key: 'v', label: 'Version', render: r => r.delivery.version },
                { key: 'del', label: 'Technical Delivered', render: r => formatDate(r.l3pkg.deliveredDate), sortVal: r => r.l3pkg.deliveredDate || '' },
                { key: 'pub', label: 'Published', render: r => formatDate(getL3PublishedDate(r.l3pkg)), sortVal: r => getL3PublishedDate(r.l3pkg) || '' },
                { key: 'delay', label: 'Delay', render: r => delayChip(r.displayDays), sortVal: r => r.displayDays ?? -1 }
            ]
        });
    }
}


// ═══════════════════════════════════════════════════════════════════════════
// DRILL DOWN (CareSet detail from Pipeline/Gaps)
// ═══════════════════════════════════════════════════════════════════════════

function drillCareSet(projectId, caresetId) {
    const proj = (data.projects || []).find(p => p.id === projectId);
    if (!proj) return;
    const cs = (data.caresets || []).find(c => c.id === caresetId && c.project === projectId);
    if (!cs) return;
    const delivery = getCurrentDelivery(cs);
    const pi = lookupPackageInfo(lookupPackageName(proj.repository));

    let html = `<div class="drill-panel">
        <h4>
            ${proj.name} / ${cs.name}
            ${delivery ? `<span style="color:var(--gray-400);font-weight:normal">v${delivery.version}</span>` : ''}
            <button class="drill-close" onclick="closeDrill()">&times;</button>
        </h4>
        <p style="color:var(--gray-600);font-size:0.875rem;margin-bottom:1rem">${cs.description || ''}</p>`;

    if (delivery) {
        if (delivery.document) {
            html += `<div style="margin-bottom:1rem">
                <strong style="font-size:0.8125rem;color:var(--gray-600)">Source Document</strong><br>
                Version ${delivery.document.version} - ${badge(delivery.document.status)} - ${formatDate(delivery.document.date)}
            </div>`;
        }

        const renderPkgSection = (pkgs, label, color) => {
            if (!pkgs || pkgs.length === 0) return '';
            let s = `<div style="margin-bottom:1rem"><strong style="font-size:0.8125rem;color:${color}">${label}</strong>`;
            for (const pkg of pkgs) {
                s += `<div style="margin:0.5rem 0 0.5rem 1rem;padding:0.5rem;background:var(--gray-50);border-radius:0.375rem;border:1px solid var(--gray-200)">
                    <strong>${pkg.package}</strong> v${pkg.version} ${badge(pkg.status)}
                    ${pkg.deliveredDate ? `<span style="font-size:0.75rem;color:var(--gray-500)"> delivered ${formatDate(pkg.deliveredDate)}</span>` : ''}
                    ${getPkgPublishedDate(pkg) ? `<span style="font-size:0.75rem;color:var(--success)"> published ${formatDate(getPkgPublishedDate(pkg))}</span>` : ''}
                    <div style="margin-top:0.5rem">`;
                for (const art of (pkg.artifacts || [])) {
                    s += renderArtifactRow(art, pi);
                }
                s += '</div></div>';
            }
            s += '</div>';
            return s;
        };

        html += renderPkgSection(delivery.l2, 'Functional — Models', 'var(--purple)');
        html += renderPkgSection(delivery.t, 'T — Terminology', 'var(--teal)');
        html += renderPkgSection(delivery.l3, 'Technical — Profiles', 'var(--primary)');

        if (cs.deliveries && cs.deliveries.length > 1) {
            html += '<details style="margin-top:0.5rem"><summary style="font-size:0.8125rem;color:var(--gray-500);cursor:pointer">Previous deliveries</summary><div style="margin-top:0.5rem">';
            for (const d of cs.deliveries.filter(dd => dd !== delivery)) {
                html += `<div style="padding:0.375rem 0;font-size:0.8125rem;border-bottom:1px solid var(--gray-100)">v${d.version} ${badge(d.status)} ${d.document ? `doc v${d.document.version}` : ''}</div>`;
            }
            html += '</div></details>';
        }
    }

    html += '</div>';
    document.getElementById('drillTarget').innerHTML = html;
    document.getElementById('drillTarget').scrollIntoView({ behavior: 'smooth' });
}

function closeDrill() { document.getElementById('drillTarget').innerHTML = ''; }


// ═══════════════════════════════════════════════════════════════════════════
// ARTIFACT SELECTOR & DOWNLOAD
// ═══════════════════════════════════════════════════════════════════════════

let selectorState = { selectedPkgs: new Set(), selectedTypes: new Set() };

function renderSelector() {
    const packages = data.packages ? Object.entries(data.packages).map(([name, info]) => ({ name, ...info })) : [];
    const allArts = getAllArtifacts();
    const artTypes = [...new Set(allArts.map(a => a.artifact.type))].sort();
    const typeLabels = {
        'logical-model': 'Logical Models', 'profile': 'Profiles', 'extension': 'Extensions',
        'valueset': 'Value Sets', 'codesystem': 'Code Systems', 'namingsystem': 'Naming Systems', 'business-rule': 'Business Rules',
        'data-dictionary': 'Data Dictionaries', 'decision-logic': 'Decision Logic',
        'indicator': 'Indicators', 'requirement': 'Requirements'
    };

    selectorState = { selectedPkgs: new Set(packages.map(p => p.name)), selectedTypes: new Set(artTypes) };

    let html = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-bottom:1.5rem">
        <div class="card">
            <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
                <span>Packages</span>
                <span style="font-size:0.75rem">
                    <a href="#" onclick="selectorToggleAllPkgs(true);return false" style="color:var(--primary)">All</a> |
                    <a href="#" onclick="selectorToggleAllPkgs(false);return false" style="color:var(--primary)">None</a>
                </span>
            </div>
            <div class="card-body" style="max-height:400px;overflow-y:auto">
                ${packages.map(p => `
                    <label style="display:flex;align-items:center;gap:0.5rem;padding:0.375rem 0;font-size:0.875rem;cursor:pointer;border-bottom:1px solid var(--gray-100)">
                        <input type="checkbox" checked class="sel-pkg" data-pkg="${p.name}" onchange="selectorUpdatePkg(this)">
                        <span style="flex:1">${p.name}</span>
                    </label>
                `).join('')}
            </div>
        </div>
        <div class="card">
            <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
                <span>Artifact Types</span>
                <span style="font-size:0.75rem">
                    <a href="#" onclick="selectorToggleAllTypes(true);return false" style="color:var(--primary)">All</a> |
                    <a href="#" onclick="selectorToggleAllTypes(false);return false" style="color:var(--primary)">None</a>
                </span>
            </div>
            <div class="card-body">
                <div style="margin-bottom:0.75rem;padding-bottom:0.75rem;border-bottom:1px solid var(--gray-200)">
                    <strong style="font-size:0.75rem;color:var(--primary)">Functional - Models</strong>
                    ${artTypes.filter(t => ['logical-model','business-rule','data-dictionary','decision-logic','indicator','requirement'].includes(t)).map(t => `
                        <label style="display:flex;align-items:center;gap:0.5rem;padding:0.25rem 0;font-size:0.875rem;cursor:pointer">
                            <input type="checkbox" checked class="sel-type" data-type="${t}" onchange="selectorUpdateType(this)">
                            <span class="badge badge-l2" style="min-width:80px">${t}</span>
                            <span style="color:var(--gray-500);font-size:0.8125rem">${typeLabels[t] || t}</span>
                        </label>
                    `).join('')}
                </div>
                <div style="margin-bottom:0.75rem;padding-bottom:0.75rem;border-bottom:1px solid var(--gray-200)">
                    <strong style="font-size:0.75rem;color:#92400e">T - Terminology</strong>
                    ${artTypes.filter(t => ['valueset','codesystem','namingsystem'].includes(t)).map(t => `
                        <label style="display:flex;align-items:center;gap:0.5rem;padding:0.25rem 0;font-size:0.875rem;cursor:pointer">
                            <input type="checkbox" checked class="sel-type" data-type="${t}" onchange="selectorUpdateType(this)">
                            <span class="badge badge-t" style="min-width:80px">${t}</span>
                            <span style="color:var(--gray-500);font-size:0.8125rem">${typeLabels[t] || t}</span>
                        </label>
                    `).join('')}
                </div>
                <div>
                    <strong style="font-size:0.75rem;color:#166534">Technical - Profiles</strong>
                    ${artTypes.filter(t => ['profile','extension'].includes(t)).map(t => `
                        <label style="display:flex;align-items:center;gap:0.5rem;padding:0.25rem 0;font-size:0.875rem;cursor:pointer">
                            <input type="checkbox" checked class="sel-type" data-type="${t}" onchange="selectorUpdateType(this)">
                            <span class="badge badge-l3" style="min-width:80px">${t}</span>
                            <span style="color:var(--gray-500);font-size:0.8125rem">${typeLabels[t] || t}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        </div>
    </div>
    <div class="card" style="margin-bottom:1.5rem">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
            <span>Selected Artifacts (<span id="selCount">0</span>)</span>
            <div style="display:flex;gap:0.5rem">
                <button class="btn btn-ghost btn-sm" onclick="selectorDownloadManifest()">Download Manifest (YAML)</button>
                <button class="btn btn-sm" style="background:var(--primary);color:white" onclick="selectorDownloadPackages()">Download Packages (ZIP)</button>
            </div>
        </div>
        <div class="card-body"><div id="dt-selector"></div></div>
    </div>
    <div id="selStatus" style="display:none;padding:1rem;background:var(--gray-50);border-radius:0.5rem;margin-bottom:1rem">
        <div id="selStatusText"></div>
        <div style="margin-top:0.5rem;height:4px;background:var(--gray-200);border-radius:2px;overflow:hidden">
            <div id="selProgress" style="height:100%;background:var(--primary);width:0%;transition:width 0.3s"></div>
        </div>
    </div>`;

    document.getElementById('viewContent').innerHTML = html;
    selectorRefreshTable();
}

function selectorUpdatePkg(el) {
    if (el.checked) selectorState.selectedPkgs.add(el.dataset.pkg);
    else selectorState.selectedPkgs.delete(el.dataset.pkg);
    selectorRefreshTable();
}

function selectorUpdateType(el) {
    if (el.checked) selectorState.selectedTypes.add(el.dataset.type);
    else selectorState.selectedTypes.delete(el.dataset.type);
    selectorRefreshTable();
}

function selectorToggleAllPkgs(on) {
    document.querySelectorAll('.sel-pkg').forEach(cb => { cb.checked = on; });
    const packages = data.packages ? Object.keys(data.packages) : [];
    selectorState.selectedPkgs = on ? new Set(packages) : new Set();
    selectorRefreshTable();
}

function selectorToggleAllTypes(on) {
    document.querySelectorAll('.sel-type').forEach(cb => { cb.checked = on; });
    const allArts = getAllArtifacts();
    const artTypes = [...new Set(allArts.map(a => a.artifact.type))];
    selectorState.selectedTypes = on ? new Set(artTypes) : new Set();
    selectorRefreshTable();
}

function selectorGetFiltered() {
    const all = getAllArtifacts();
    return all.filter(a => {
        if (!selectorState.selectedTypes.has(a.artifact.type)) return false;
        const pkgName = a.pkg ? a.pkg.package : (a.artifact.package || lookupPackageName(a.project.repository));
        return pkgName && selectorState.selectedPkgs.has(pkgName);
    });
}

function selectorRefreshTable() {
    const filtered = selectorGetFiltered();
    document.getElementById('selCount').textContent = filtered.length;
    createDT('dt-selector', {
        data: filtered.map((a, i) => ({ ...a, _dtId: String(i) })),
        defaultSort: 0,
        columns: [
            { key: 'name', label: 'Name', render: r => `<strong>${r.artifact.name}</strong>`, sortVal: r => r.artifact.name, searchVal: r => r.artifact.name },
            { key: 'type', label: 'Type', render: r => r.artifact.type, sortVal: r => r.artifact.type },
            { key: 'layer', label: 'Layer', render: r => `<span class="badge badge-${r.layer.toLowerCase()}">${r.layer}</span>`, sortVal: r => r.layer },
            { key: 'status', label: 'Status', render: r => badge(r.artifact.status), sortVal: r => STATUS_ORDER[r.artifact.status] || 0 },
            { key: 'proj', label: 'Project', render: r => r.project.name, sortVal: r => r.project.name, searchVal: r => r.project.name },
            { key: 'cs', label: 'CareSet', render: r => r.careset ? r.careset.name : '-', sortVal: r => r.careset ? r.careset.name : '', searchVal: r => r.careset ? r.careset.name : '' },
            { key: 'pkg', label: 'Package', render: r => r.pkg ? r.pkg.package : (r.artifact.package || '-'), sortVal: r => r.pkg ? r.pkg.package : '' }
        ]
    });
}

function selectorDownloadManifest() {
    const filtered = selectorGetFiltered();
    if (filtered.length === 0) { alert('No artifacts selected.'); return; }
    const byPkg = {};
    for (const a of filtered) {
        const pkgName = a.pkg ? a.pkg.package : (a.artifact.package || lookupPackageName(a.project.repository) || 'unknown');
        if (!byPkg[pkgName]) byPkg[pkgName] = { artifacts: [] };
        byPkg[pkgName].artifacts.push({
            name: a.artifact.name, type: a.artifact.type, layer: a.layer, status: a.artifact.status,
            project: a.project.name, careset: a.careset ? a.careset.name : null
        });
    }
    const manifest = {
        generated: new Date().toISOString(),
        context: data.context ? data.context.name : 'Unknown',
        totalArtifacts: filtered.length,
        packages: byPkg
    };
    const yamlStr = jsyaml.dump(manifest, { lineWidth: -1 });
    const blob = new Blob([yamlStr], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'artifact-selection.yaml'; a.click();
    URL.revokeObjectURL(url);
}

const FHIR_PACKAGES_API = 'https://packages2.fhir.org';

async function selectorDownloadPackages() {
    const filtered = selectorGetFiltered();
    if (filtered.length === 0) { alert('No artifacts selected.'); return; }
    const pkgsToFetch = new Map();
    for (const a of filtered) {
        const pkgName = a.pkg ? a.pkg.package : (a.artifact.package || lookupPackageName(a.project.repository));
        const version = a.delivery ? a.delivery.version : 'latest';
        if (pkgName && !pkgsToFetch.has(pkgName)) pkgsToFetch.set(pkgName, { name: pkgName, version });
    }

    const statusEl = document.getElementById('selStatus');
    const statusText = document.getElementById('selStatusText');
    const progressEl = document.getElementById('selProgress');
    statusEl.style.display = 'block';

    const zip = new JSZip();
    let done = 0;
    const total = pkgsToFetch.size;

    for (const [pkgName, info] of pkgsToFetch) {
        statusText.textContent = `Fetching ${pkgName}... (${done + 1}/${total})`;
        progressEl.style.width = `${(done / total) * 100}%`;
        try {
            let tgzUrl = `${FHIR_PACKAGES_API}/packages/${pkgName}/${info.version}`;
            let resp = await fetch(tgzUrl, { headers: { Accept: 'application/gzip' } });
            if (!resp.ok) {
                tgzUrl = `${FHIR_PACKAGES_API}/packages/${pkgName}`;
                resp = await fetch(tgzUrl, { headers: { Accept: 'application/gzip' } });
            }
            if (resp.ok) {
                const blob = await resp.blob();
                zip.file(`${pkgName}-${info.version}.tgz`, blob);
            } else {
                zip.file(`${pkgName}-${info.version}.not-found.txt`, `Package not found (HTTP ${resp.status})`);
            }
        } catch (e) {
            zip.file(`${pkgName}-${info.version}.error.txt`, `Failed: ${e.message}`);
        }
        done++;
    }

    const manifest = { generated: new Date().toISOString(), context: data.context ? data.context.name : 'Unknown', totalArtifacts: filtered.length };
    zip.file('manifest.yaml', jsyaml.dump(manifest, { lineWidth: -1 }));

    statusText.textContent = 'Creating ZIP...';
    progressEl.style.width = '100%';
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    const ctx = data.context ? data.context.shortName.toLowerCase() : 'fhir';
    a.href = url; a.download = `${ctx}-packages-${new Date().toISOString().slice(0, 10)}.zip`; a.click();
    URL.revokeObjectURL(url);
    statusText.textContent = `Done! Downloaded ${total} package(s).`;
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
}


// ═══════════════════════════════════════════════════════════════════════════
// REPORTS VIEW — Parameterized search & reporting
// ═══════════════════════════════════════════════════════════════════════════

let currentReport = null; // tracks which report is shown
let currentReportFilter = null; // optional filter (e.g. { layer: 'T', type: 'valueset' })

function renderReports() {
    console.log('renderReports — data.projects:', (data.projects||[]).length, 'data.caresets:', (data.caresets||[]).length, 'data.packages:', Object.keys(data.packages||{}).length);
    const allArts = getAllArtifacts();
    console.log('renderReports — allArts:', allArts.length);
    const pkgMap = getPackageArtifacts();

    // Aggregate stats
    const byLayer = { L2: [], T: [], L3: [] };
    const byType = {};
    const byPackage = {};
    for (const a of allArts) {
        (byLayer[a.layer] = byLayer[a.layer] || []).push(a);
        (byType[a.artifact.type] = byType[a.artifact.type] || []).push(a);
        const pkgName = a.artifact.package || (a.pkg && a.pkg.package) || '(unknown)';
        (byPackage[pkgName] = byPackage[pkgName] || []).push(a);
    }

    const typeLabels = {
        'logical-model': 'Logical Models', 'profile': 'Profiles', 'extension': 'Extensions',
        'valueset': 'Value Sets', 'codesystem': 'Code Systems', 'namingsystem': 'Naming Systems',
        'business-rule': 'Business Rules', 'data-dictionary': 'Data Dictionaries',
        'decision-logic': 'Decision Logic', 'indicator': 'Indicators', 'requirement': 'Requirements'
    };

    // Summary cards (clickable)
    let html = `<div style="margin-bottom:1.5rem">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:1.5rem">
            <div class="stat-card" style="cursor:pointer;border-left:4px solid var(--primary)" onclick="showReport('layer','L2')">
                <div class="stat-value">${byLayer.L2.length}</div>
                <div class="stat-label">Functional — Models</div>
            </div>
            <div class="stat-card" style="cursor:pointer;border-left:4px solid var(--warning)" onclick="showReport('layer','T')">
                <div class="stat-value">${byLayer.T.length}</div>
                <div class="stat-label">T — Terminology</div>
            </div>
            <div class="stat-card" style="cursor:pointer;border-left:4px solid var(--success)" onclick="showReport('layer','L3')">
                <div class="stat-value">${byLayer.L3.length}</div>
                <div class="stat-label">Technical — Profiles</div>
            </div>
        </div>`;

    // By-type summary table (clickable rows)
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem">
        <div class="card">
            <div class="card-header">By Type</div>
            <div class="card-body" style="padding:0">
                <table><thead><tr><th>Type</th><th style="text-align:right">Count</th></tr></thead><tbody>`;
    for (const [type, arts] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
        const label = typeLabels[type] || type;
        const layerColor = ['logical-model','business-rule','data-dictionary','decision-logic','indicator','requirement'].includes(type) ? 'var(--primary)'
            : ['valueset','codesystem','namingsystem'].includes(type) ? 'var(--warning)' : 'var(--success)';
        html += `<tr style="cursor:pointer" onclick="showReport('type','${type}')">
            <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${layerColor};margin-right:0.5rem"></span>${label}</td>
            <td style="text-align:right"><a href="#" onclick="event.preventDefault();showReport('type','${type}')" style="color:var(--primary);font-weight:600">${arts.length}</a></td>
        </tr>`;
    }
    html += `</tbody></table></div></div>`;

    // By-package summary table (clickable rows)
    html += `<div class="card">
            <div class="card-header">By Package</div>
            <div class="card-body" style="padding:0;max-height:400px;overflow-y:auto">
                <table><thead><tr><th>Package</th><th style="text-align:right">Count</th></tr></thead><tbody>`;
    for (const [pkg, arts] of Object.entries(byPackage).sort((a, b) => b[1].length - a[1].length)) {
        const shortPkg = pkg.replace('hl7.fhir.be.', '');
        html += `<tr style="cursor:pointer" onclick="showReport('package','${pkg}')">
            <td>${shortPkg}</td>
            <td style="text-align:right"><a href="#" onclick="event.preventDefault();showReport('package','${pkg}')" style="color:var(--primary);font-weight:600">${arts.length}</a></td>
        </tr>`;
    }
    html += `</tbody></table></div></div></div>`;

    // Pre-built report buttons
    html += `<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1rem">
        <button class="btn btn-sm${currentReport === 'valuesets' ? ' btn-primary' : ' btn-ghost'}" onclick="showReport('valuesets')">ValueSets Detail</button>
        <button class="btn btn-sm${currentReport === 'codesystems' ? ' btn-primary' : ' btn-ghost'}" onclick="showReport('codesystems')">CodeSystems Detail</button>
        <button class="btn btn-sm${currentReport === 'namingsystems' ? ' btn-primary' : ' btn-ghost'}" onclick="showReport('namingsystems')">NamingSystems Detail</button>
        <button class="btn btn-sm${currentReport === 'profiles' ? ' btn-primary' : ' btn-ghost'}" onclick="showReport('profiles')">Profiles Detail</button>
        <button class="btn btn-sm${currentReport === 'extensions' ? ' btn-primary' : ' btn-ghost'}" onclick="showReport('extensions')">Extensions Detail</button>
        <button class="btn btn-sm${currentReport === 'logical-models' ? ' btn-primary' : ' btn-ghost'}" onclick="showReport('logical-models')">Logical Models Detail</button>
        <button class="btn btn-sm${currentReport === 'inactive' ? ' btn-primary' : ' btn-ghost'}" onclick="showReport('inactive')" style="margin-left:0.5rem;border-color:var(--danger)">Inactive Concepts</button>
    </div>`;

    html += `</div>`;

    // Report result area
    html += `<div id="reportResult"></div>`;

    document.getElementById('viewContent').innerHTML = html;

    // Re-render current report if one was active
    if (currentReport) {
        setTimeout(() => showReport(currentReport, currentReportFilter), 0);
    }
}

function showReport(reportType, filter) {
    currentReport = reportType;
    currentReportFilter = filter || null;

    // Re-render the summary to update active button styles
    // but only the buttons, not the whole view
    const buttons = document.querySelectorAll('#viewContent .btn-sm');
    buttons.forEach(b => {
        const isActive = b.textContent.toLowerCase().replace(/\s+detail/, 's').replace(/\s/g, '-') === reportType
            || b.textContent.toLowerCase().replace(' detail', '') === reportType;
        b.className = `btn btn-sm ${isActive ? 'btn-primary' : 'btn-ghost'}`;
    });

    const container = document.getElementById('reportResult');
    if (!container) return;

    const allArts = getAllArtifacts();
    let filtered = allArts;
    let title = '';

    // Filter based on report type
    if (reportType === 'layer') {
        filtered = allArts.filter(a => a.layer === filter);
        title = `${filter} Layer Artifacts`;
    } else if (reportType === 'type') {
        filtered = allArts.filter(a => a.artifact.type === filter);
        title = `${filter} Artifacts`;
    } else if (reportType === 'package') {
        filtered = allArts.filter(a => {
            const pkgName = a.artifact.package || (a.pkg && a.pkg.package) || '';
            return pkgName === filter;
        });
        title = `Artifacts in ${filter.replace('hl7.fhir.be.', '')}`;
    } else if (reportType === 'valuesets') {
        filtered = allArts.filter(a => a.artifact.type === 'valueset');
        title = 'ValueSets';
    } else if (reportType === 'codesystems') {
        filtered = allArts.filter(a => a.artifact.type === 'codesystem');
        title = 'CodeSystems';
    } else if (reportType === 'namingsystems') {
        filtered = allArts.filter(a => a.artifact.type === 'namingsystem');
        title = 'NamingSystems';
    } else if (reportType === 'profiles') {
        filtered = allArts.filter(a => a.artifact.type === 'profile');
        title = 'Profiles';
    } else if (reportType === 'extensions') {
        filtered = allArts.filter(a => a.artifact.type === 'extension');
        title = 'Extensions';
    } else if (reportType === 'logical-models') {
        filtered = allArts.filter(a => a.artifact.type === 'logical-model');
        title = 'Logical Models';
    } else if (reportType === 'inactive') {
        // Show ValueSets that have inactive concepts (from tx expansion)
        filtered = allArts.filter(a => {
            if (a.artifact.type !== 'valueset') return false;
            const meta = (data.artifactMeta || {});
            const m = meta[(a.artifact.id || '').toLowerCase()];
            return m && m.txInactiveCount > 0;
        });
        title = 'ValueSets with Inactive Concepts';
    }

    // Deduplicate by id|type (same logic as elsewhere)
    const seen = new Map();
    const deduped = [];
    for (const a of filtered) {
        const key = `${(a.artifact.id || '').toLowerCase()}|${a.artifact.type}`;
        if (!seen.has(key)) {
            seen.set(key, true);
            deduped.push(a);
        }
    }

    // Build columns based on report type
    const isValueSet = reportType === 'valuesets' || reportType === 'inactive' || (reportType === 'type' && filter === 'valueset');

    const columns = [
        { key: 'name', label: 'Name', render: r => {
            const artResType = ['logical-model','profile','extension'].includes(r.type) ? 'StructureDefinition'
                : r.type === 'valueset' ? 'ValueSet' : r.type === 'codesystem' ? 'CodeSystem'
                : r.type === 'namingsystem' ? 'NamingSystem' : null;
            const pkgInfo = data.packages[r.package] || {};
            const pubUrl = pkgInfo.publicationUrl;
            const url = (pubUrl && artResType && r.id) ? `${pubUrl}/${artResType}/${r.id}` : null;
            return url ? `<a href="${url}" target="_blank" style="color:var(--primary)">${r.name || r.id}</a>` : (r.name || r.id);
        }, searchVal: r => r.name || r.id },
        { key: 'id', label: 'ID' },
        { key: 'type', label: 'Type' },
        { key: 'layer', label: 'Layer', render: r => `<span class="badge badge-${r.layer.toLowerCase()}">${r.layer}</span>` },
        { key: 'package', label: 'Package', render: r => (r.package || '').replace('hl7.fhir.be.', ''), searchVal: r => r.package || '' },
        { key: 'status', label: 'Status', render: r => `<span class="badge badge-${r.status || 'planned'}">${r.status || 'planned'}</span>` }
    ];

    // Add concept count and composition columns for ValueSets
    if (isValueSet) {
        columns.splice(3, 0, {
            key: 'conceptCount', label: 'Concepts',
            sortVal: r => r.conceptCount ?? -1,
            render: r => r.conceptCount != null ? `<span style="font-weight:600">${r.conceptCount}</span>` : '<span style="color:var(--gray-400)">—</span>'
        });
        columns.splice(4, 0, {
            key: 'vsComposition', label: 'Content',
            render: r => {
                if (r.vsComposition === 'intensional') return '<span style="color:var(--purple);font-weight:500">intensional</span>';
                if (r.vsComposition === 'extensional') return '<span style="color:var(--teal);font-weight:500">extensional</span>';
                return '<span style="color:var(--gray-400)">—</span>';
            },
            searchVal: r => r.vsComposition || ''
        });
        // TX server columns (only if any data has tx results)
        const hasTxData = reportType === 'inactive' || deduped.some(a => {
            const meta = (data.artifactMeta || {});
            const m = meta[(a.artifact.id || '').toLowerCase()];
            return m && m.txInactiveCount != null;
        });
        if (hasTxData) {
            columns.push({
                key: 'txInactiveCount', label: 'Inactive',
                sortVal: r => r.txInactiveCount ?? -1,
                render: r => {
                    if (r.txInactiveCount == null) return '<span style="color:var(--gray-400)">—</span>';
                    const id = (r.id || '').replace(/'/g, "\\'");
                    const pkg = (r.package || '').replace(/'/g, "\\'");
                    if (r.txInactiveCount > 0) return `<a href="#" onclick="event.preventDefault();queryInactiveConcepts('${id}','${pkg}')" style="color:var(--danger);font-weight:600;text-decoration:underline;cursor:pointer">${r.txInactiveCount}</a>`;
                    return '<span style="color:var(--success)">0</span>';
                }
            });
        }
    }

    // Add fhirBase column for profiles
    const isProfile = reportType === 'profiles' || (reportType === 'type' && filter === 'profile');
    if (isProfile) {
        columns.splice(3, 0, { key: 'fhirBase', label: 'Base Resource', render: r => r.fhirBase || '—' });
    }

    // Flatten for DataTable
    const rows = deduped.map(a => {
        const pkgName = a.artifact.package || (a.pkg && a.pkg.package) || '';
        const row = {
            name: a.artifact.name || a.artifact.id,
            id: a.artifact.id,
            type: a.artifact.type,
            layer: a.layer,
            package: pkgName,
            status: a.artifact.status || 'planned',
            fhirBase: a.artifact.fhirBase || null
        };
        // Look up VS metadata from crawl results or expansions
        if (isValueSet) {
            const meta = (data.artifactMeta || {});
            const artKey = (a.artifact.id || '').toLowerCase();
            const m = meta[`${artKey}|${pkgName}`] || meta[artKey];
            if (m) {
                row.conceptCount = m.conceptCount;
                row.vsComposition = m.vsComposition;
                row.txInactiveCount = m.txInactiveCount;
            } else {
                // Fallback to expansions data
                const expPkg = (data.expansions || {})[pkgName] || {};
                const exp = expPkg[a.artifact.id] || expPkg[a.artifact.name];
                row.conceptCount = exp ? exp.conceptCount : null;
                row.vsComposition = exp ? exp.composition : null;
                row.txInactiveCount = null;
            }
        }
        return row;
    });

    container.innerHTML = `<div class="card">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
            <span>${title} (${rows.length})</span>
            <div style="display:flex;gap:0.5rem">
                <button class="btn btn-ghost btn-sm" onclick="exportReportCSV()">CSV</button>
                <button class="btn btn-ghost btn-sm" onclick="exportReportMarkdown()">Markdown</button>
            </div>
        </div>
        <div class="card-body"><div id="dt-report"></div></div>
    </div>`;

    setTimeout(() => {
        createDT('dt-report', {
            columns,
            data: rows,
            pageSize: 25,
            defaultSort: 0,
            defaultSortDir: 'asc'
        });
    }, 0);
}

function getReportDTData() {
    const dt = dtInstances['dt-report'];
    if (!dt) return null;
    return { filtered: dt.getFilteredData(), columns: dt.columns };
}

function exportReportCSV() {
    const d = getReportDTData();
    if (!d) return;
    const header = d.columns.map(c => c.label).join(',');
    const csvRows = d.filtered.map(row =>
        d.columns.map(c => {
            let val = row[c.key] ?? '';
            val = String(val).replace(/"/g, '""');
            return `"${val}"`;
        }).join(',')
    );
    const csv = [header, ...csvRows].join('\n');
    downloadBlob(csv, 'text/csv', `report-${currentReport}${currentReportFilter ? '-' + currentReportFilter : ''}.csv`);
}

function exportReportMarkdown() {
    const d = getReportDTData();
    if (!d) return;
    const cols = d.columns;
    const header = '| ' + cols.map(c => c.label).join(' | ') + ' |';
    const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
    const rows = d.filtered.map(row =>
        '| ' + cols.map(c => {
            let val = row[c.key] ?? '';
            return String(val).replace(/\|/g, '\\|');
        }).join(' | ') + ' |'
    );
    const md = `# ${currentReport}${currentReportFilter ? ' — ' + currentReportFilter : ''}\n\n${d.filtered.length} items\n\n${header}\n${sep}\n${rows.join('\n')}\n`;
    downloadBlob(md, 'text/markdown', `report-${currentReport}${currentReportFilter ? '-' + currentReportFilter : ''}.md`);
}

// Render the Inactive Concepts panel from already-resolved data. Shared by
// the cache path (read from artifactMeta — no tx round-trip) and the live
// tx-server path (after a successful $expand). Both paths feed the same
// shape: an array of {system, code, display} for inactive entries plus a
// total / active count and the VS composition flag.
function renderInactivePanel(panel, opts) {
    const { vsId, vsTitle, total, inactive, composition, source, error } = opts;
    if (error) {
        panel.innerHTML = `<div class="card" style="margin-top:1rem;border-color:var(--danger)">
            <div class="card-header">Inactive Concepts — ${vsId}
                <button class="drill-close" onclick="this.closest('.card').remove()">&times;</button>
            </div>
            <div class="card-body"><p style="color:var(--danger)">${error}</p></div>
        </div>`;
        return;
    }
    const inactiveCount = inactive.length;
    const activeCount = (typeof total === 'number') ? Math.max(0, total - inactiveCount) : null;
    const compTag = composition === 'intensional'
        ? '<span style="color:var(--purple);font-weight:500">intensional</span>'
        : composition === 'extensional'
            ? '<span style="color:var(--teal);font-weight:500">extensional</span>'
            : '<span style="color:var(--gray-400)">unknown content</span>';
    const sourceTag = source === 'cached'
        ? '<span style="font-size:0.6875rem;color:var(--gray-500);margin-left:0.5rem">(from cached snapshot)</span>'
        : source === 'tx'
            ? '<span style="font-size:0.6875rem;color:var(--gray-500);margin-left:0.5rem">(live from tx)</span>'
            : '';
    let html = `<div style="margin-bottom:0.75rem;font-size:0.8125rem;color:var(--gray-600)">
        Content: ${compTag} ·
        Total concepts: <strong>${total ?? '—'}</strong>,
        Inactive: <strong style="color:var(--danger)">${inactiveCount}</strong>${activeCount != null ? `, Active: <strong style="color:var(--success)">${activeCount}</strong>` : ''}
        ${sourceTag}
        ${inactiveCount > 0 ? `<button class="btn btn-ghost btn-sm" style="margin-left:1rem" onclick="downloadBlob(document.getElementById('inactiveTable').innerText,'text/csv','inactive-${vsId}.csv')">Export</button>` : ''}
    </div>`;

    if (inactiveCount === 0) {
        html += '<p style="color:var(--success)">No inactive concepts found.</p>';
    } else {
        html += `<div style="max-height:400px;overflow-y:auto"><table id="inactiveTable">
            <thead><tr><th>System</th><th>Code</th><th>Display</th></tr></thead><tbody>`;
        for (const c of inactive) {
            const sys = (c.system || '').replace(/^http:\/\/snomed\.info\/sct$/, 'SNOMED').replace(/^http:\/\/loinc\.org$/, 'LOINC');
            html += `<tr><td style="font-size:0.75rem;color:var(--gray-500)">${sys}</td><td style="font-weight:500">${c.code || ''}</td><td>${c.display || ''}</td></tr>`;
        }
        html += '</tbody></table></div>';
    }

    panel.innerHTML = `<div class="card" style="margin-top:1rem;border-color:${inactiveCount > 0 ? 'var(--danger)' : 'var(--success)'}">
        <div class="card-header">Inactive Concepts — ${vsTitle || vsId}
            <button class="drill-close" onclick="this.closest('.card').remove()">&times;</button>
        </div>
        <div class="card-body">${html}</div>
    </div>`;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function queryInactiveConcepts(vsId, pkgName) {
    let panel = document.getElementById('inactiveConceptsPanel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'inactiveConceptsPanel';
        document.getElementById('reportResult').appendChild(panel);
    }

    // Cache hit path: a previous crawl persisted the inactive list +
    // composition + counts into artifactMeta. Render directly — no tx
    // round-trip. This is the path the deployed (no-crawl) build relies on.
    const meta = (data && data.artifactMeta) || {};
    const cacheKey = `${(vsId || '').toLowerCase()}|${pkgName}`;
    const cachedMeta = meta[cacheKey] || meta[(vsId || '').toLowerCase()];
    const cachedInactive = cachedMeta && cachedMeta.inactiveConcepts;
    if (Array.isArray(cachedInactive)) {
        renderInactivePanel(panel, {
            vsId,
            vsTitle: vsId,
            total: cachedMeta.txConceptCount ?? cachedMeta.conceptCount,
            inactive: cachedInactive,
            composition: cachedMeta.vsComposition,
            source: 'cached'
        });
        return;
    }

    // No cache — fall back to a live tx round-trip (only works in builds
    // where Crawl is enabled and a tx server is reachable).
    const txServer = window.crawlTxServerUrl || 'http://localhost/tx/r4';
    const crawlResults = window._lastCrawlResults || {};
    const pkgResult = crawlResults[pkgName];
    let vsResource = null;
    if (pkgResult) {
        const pkgInfo = (data.packages || {})[pkgName] || {};
        const pubUrl = pkgInfo.publicationUrl;
        if (pubUrl) {
            try {
                const proxyBase = pubUrl.includes('ehealth.fgov.be') ? pubUrl.replace('https://ehealth.fgov.be', '/proxy/ehealth') : pubUrl;
                const resp = await fetch(`${proxyBase}/ValueSet-${vsId}.json`);
                if (resp.ok) vsResource = await resp.json();
            } catch {}
        }
    }

    if (!vsResource) {
        renderInactivePanel(panel, {
            vsId,
            error: `No cached data and could not fetch ValueSet resource for ${vsId}. Run a crawl with tx expansion, or check the publication URL.`
        });
        return;
    }

    panel.innerHTML = `<div class="card" style="margin-top:1rem;border-color:var(--warning)">
        <div class="card-header">Inactive Concepts — ${vsResource.title || vsResource.name || vsId}
            <button class="drill-close" onclick="this.closest('.card').remove()">&times;</button>
        </div>
        <div class="card-body"><p style="color:var(--gray-500)">Expanding via ${txServer}...</p></div>
    </div>`;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
        const txUrl = txServer.includes('localhost') || txServer.includes('127.0.0.1')
            ? `/proxy/tx${new URL(txServer).pathname}/ValueSet/$expand`
            : `${txServer}/ValueSet/$expand`;
        const params = 'activeOnly=false&property=inactive';
        const resp = await fetch(`${txUrl}?${params}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
            body: JSON.stringify(vsResource)
        });
        const result = await resp.json();

        if (result.resourceType === 'OperationOutcome' || !result.expansion) {
            const msg = result.issue?.[0]?.details?.text || result.issue?.[0]?.diagnostics || 'Unknown error';
            renderInactivePanel(panel, { vsId, vsTitle: vsResource.title || vsResource.name || vsId, error: msg });
            return;
        }

        const contains = result.expansion.contains || [];
        const inactive = contains.filter(c => {
            if (c.inactive === true) return true;
            if (c.property) {
                for (const p of c.property) {
                    if (p.code === 'inactive' && p.valueBoolean === true) return true;
                }
            }
            return false;
        }).map(c => ({ system: c.system || '', code: c.code || '', display: c.display || '' }));

        // Derive composition from the resource itself for the live path —
        // mirrors classifyValueSet() in src/crawler.js but inline so tracker.js
        // doesn't need to import the module.
        const includes = vsResource.compose?.include || [];
        const hasFilter = includes.some(inc => inc.filter && inc.filter.length > 0);
        const hasConcepts = includes.some(inc => inc.concept && inc.concept.length > 0);
        const composition = hasFilter ? 'intensional' : (hasConcepts ? 'extensional' : 'unknown');

        renderInactivePanel(panel, {
            vsId,
            vsTitle: vsResource.title || vsResource.name || vsId,
            total: result.expansion.total ?? contains.length,
            inactive,
            composition,
            source: 'tx'
        });
    } catch (e) {
        renderInactivePanel(panel, { vsId, vsTitle: vsResource.title || vsResource.name || vsId, error: `Failed to query tx server: ${e.message}` });
    }
}

function downloadBlob(content, type, filename) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}


// ═══════════════════════════════════════════════════════════════════════════
// REPORT PROGRESS MODE
// ═══════════════════════════════════════════════════════════════════════════

function renderReport() {
    const projects = data.projects || [];
    let html = `<p style="color:var(--gray-600);font-size:0.875rem;margin-bottom:1rem">Select a CareSet to report progress. Updates are saved to browser storage.</p>`;

    for (const proj of projects) {
        html += `<div class="tree-item">
            <div class="tree-header" onclick="toggleTree(this)">
                <svg class="tree-toggle" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                <span class="tree-name">${proj.name}</span>
                ${badge(proj.status)}
                ${proj.transversal ? '<span class="badge badge-approved">transversal</span>' : ''}
                <span class="tree-meta">${getCareSetsForProject(proj.id).length} caresets</span>
            </div>
            <div class="tree-children">`;
        for (const cs of getCareSetsForProject(proj.id)) {
            const delivery = getCurrentDelivery(cs);
            html += `<div class="tree-item">
                <div class="tree-header" onclick="toggleTree(this)">
                    <svg class="tree-toggle" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                    <span class="tree-name">${cs.name}</span>
                    ${badge(cs.status)}
                    <span class="tree-meta">${delivery ? 'v' + delivery.version : 'no delivery'}</span>
                </div>
                <div class="tree-children">${renderReportForm(proj, cs, delivery)}</div>
            </div>`;
        }
        html += '</div></div>';
    }
    document.getElementById('viewContent').innerHTML = html;
}

function renderReportForm(proj, cs, delivery) {
    if (!delivery) return '<p style="color:var(--gray-500);font-size:0.875rem">No delivery defined yet.</p>';
    const doc = delivery.document || {};

    let html = `<div class="form-grid" style="margin-bottom:1rem">
        <div style="grid-column:1/-1;font-size:0.8125rem;font-weight:600;color:var(--gray-600);border-bottom:1px solid var(--gray-200);padding-bottom:0.25rem">Delivery v${delivery.version}</div>
        <div class="form-group"><label>Document Version</label><input type="text" value="${doc.version || ''}" data-field="document.version" data-proj="${proj.id}" data-cs="${cs.id}" onchange="updateField(this)"></div>
        <div class="form-group"><label>Document Status</label><select data-field="document.status" data-proj="${proj.id}" data-cs="${cs.id}" onchange="updateField(this)">${statusOptions(doc.status)}</select></div>
        <div class="form-group"><label>Document Date</label><input type="date" value="${doc.date || ''}" data-field="document.date" data-proj="${proj.id}" data-cs="${cs.id}" onchange="updateField(this)"></div>`;

    for (let i = 0; i < (delivery.l2 || []).length; i++) {
        const pkg = delivery.l2[i];
        html += `<div style="grid-column:1/-1;font-size:0.8125rem;font-weight:600;color:var(--primary);margin-top:0.5rem;border-bottom:1px solid var(--gray-200);padding-bottom:0.25rem">Functional: ${pkg.package} v${pkg.version}</div>
            <div class="form-group"><label>Status</label><select data-field="l2.${i}.status" data-proj="${proj.id}" data-cs="${cs.id}" onchange="updateField(this)">${statusOptions(pkg.status)}</select></div>
            <div class="form-group"><label>Delivered Date</label><input type="date" value="${pkg.deliveredDate || ''}" data-field="l2.${i}.deliveredDate" data-proj="${proj.id}" data-cs="${cs.id}" onchange="updateField(this)"></div>`;
    }
    for (let i = 0; i < (delivery.t || []).length; i++) {
        const pkg = delivery.t[i];
        html += `<div style="grid-column:1/-1;font-size:0.8125rem;font-weight:600;color:#92400e;margin-top:0.5rem;border-bottom:1px solid var(--gray-200);padding-bottom:0.25rem">Terminology: ${pkg.package} v${pkg.version}</div>
            <div class="form-group"><label>Status</label><select data-field="t.${i}.status" data-proj="${proj.id}" data-cs="${cs.id}" onchange="updateField(this)">${statusOptions(pkg.status)}</select></div>
            <div class="form-group"><label>Delivered Date</label><input type="date" value="${pkg.deliveredDate || ''}" data-field="t.${i}.deliveredDate" data-proj="${proj.id}" data-cs="${cs.id}" onchange="updateField(this)"></div>`;
    }
    for (let i = 0; i < (delivery.l3 || []).length; i++) {
        const pkg = delivery.l3[i];
        html += `<div style="grid-column:1/-1;font-size:0.8125rem;font-weight:600;color:var(--primary);margin-top:0.5rem;border-bottom:1px solid var(--gray-200);padding-bottom:0.25rem">Technical: ${pkg.package} v${pkg.version}</div>
            <div class="form-group"><label>Status</label><select data-field="l3.${i}.status" data-proj="${proj.id}" data-cs="${cs.id}" onchange="updateField(this)">${statusOptions(pkg.status)}</select></div>
            <div class="form-group"><label>WG Delivered Date</label><input type="date" value="${pkg.deliveredDate || ''}" data-field="l3.${i}.deliveredDate" data-proj="${proj.id}" data-cs="${cs.id}" onchange="updateField(this)"></div>
            <div class="form-group"><label>Federal Published Date</label><input type="date" value="${pkg.publishedDate || ''}" data-field="l3.${i}.publishedDate" data-proj="${proj.id}" data-cs="${cs.id}" onchange="updateField(this)"></div>`;
    }
    html += `<div class="form-group form-full" style="margin-top:0.5rem">
        <button class="btn btn-primary btn-sm" onclick="saveProgress()">Save All Changes</button>
        <span id="saveStatus" style="font-size:0.75rem;color:var(--success);margin-left:0.5rem"></span>
    </div></div>`;
    return html;
}

function statusOptions(current) {
    return ['planned', 'wip', 'draft', 'review', 'approved', 'published', 'deprecated']
        .map(s => `<option value="${s}" ${s === current ? 'selected' : ''}>${s}</option>`).join('');
}

function toggleTree(header) {
    header.querySelector('.tree-toggle').classList.toggle('open');
    header.nextElementSibling.classList.toggle('open');
}

function updateField(el) {
    const proj = (data.projects || []).find(p => p.id === el.dataset.proj);
    if (!proj) return;
    const cs = (data.caresets || []).find(c => c.id === el.dataset.cs && c.project === proj.id);
    if (!cs) return;
    const delivery = getCurrentDelivery(cs);
    if (!delivery) return;
    const parts = el.dataset.field.split('.');
    const value = el.value || null;
    if (parts[0] === 'document') {
        if (!delivery.document) delivery.document = {};
        delivery.document[parts[1]] = value;
    } else if (['l2', 'l3', 't'].includes(parts[0])) {
        const idx = parseInt(parts[1]);
        if (delivery[parts[0]] && delivery[parts[0]][idx]) delivery[parts[0]][idx][parts[2]] = value;
    }
}

function saveProgress() {
    try {
        localStorage.setItem('fhir-tracker-data', JSON.stringify(data));
        const el = document.getElementById('saveStatus');
        if (el) { el.textContent = 'Saved!'; setTimeout(() => { el.textContent = ''; }, 2000); }
    } catch (e) { console.error('Save failed:', e); }
}



// ═══════════════════════════════════════════════════════════════════════════
// TIMELINE — vis-timeline view of each IG's lifecycle.
// Line semantics:
//   - dotted   = workgroup discussion (WIP)
//   - dashed   = public comment (only when release approved)
//   - solid    = released (from first release forward)
//   - diamond  = release milestone
// Pan/zoom/hover are handled by vis-timeline itself.
// ═══════════════════════════════════════════════════════════════════════════
function renderTimelineInteractive() {
    const container = document.getElementById('viewContent');
    if (!window.visTimeline) {
        container.innerHTML = '<div class="card"><div class="card-body" style="color:var(--danger)">vis-timeline failed to load.</div></div>';
        return;
    }
    const { Timeline, DataSet } = window.visTimeline;

    // Collect timeline packages (same filter as the SVG version)
    const pkgs = [];
    for (const [name, info] of Object.entries(data.packages || {})) {
        if (!info.timeline || info.timeline.length === 0) continue;
        const sorted = [...info.timeline].sort((a, b) =>
            new Date(a.buildStart || a.release || 0).getTime() - new Date(b.buildStart || b.release || 0).getTime()
        );
        pkgs.push({ name, shortName: name.replace(/^hl7\.fhir\.\w+\./, ''), info, timeline: sorted });
    }
    if (pkgs.length === 0) {
        container.innerHTML = '<div class="card"><div class="card-body" style="color:var(--gray-400);padding:3rem;text-align:center">No timeline data.</div></div>';
        return;
    }
    pkgs.sort((a, b) => a.shortName.localeCompare(b.shortName));

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const pcColor = '#9ca316';
    // Single dark blue for every IG row for now. Later we'll drive the colour
    // from an IG category (BeSafeShare / Community / transversal / …).
    const igColors = ['#1e3a8a'];

    // Build groups (one row per IG) and items (segments + diamonds + PC overlays)
    const groups = [];
    const items = [];
    let itemId = 0;

    // Subgroups keep concurrent tracks visible: 'a-work' (top) shows WIP + PC,
    // 'b-released' (bottom) shows the released line + release diamonds. Alphabetic
    // subgroup names enforce the top→bottom order.
    pkgs.forEach((pkg, i) => {
        const color = igColors[i % igColors.length];
        // Label is the IG name (the project that publishes this package, e.g.
        // "Belgian Core Profiles"), falling back to the package short name.
        // Group labels are handled via vis-timeline's `click` event below
        // because HTML onclick handlers get sanitised out of group content.
        const igName = lookupIGName(pkg.name);
        groups.push({
            id: pkg.name,
            content: `<span class="gt2-group-link" title="Click to open ${pkg.name} in the Explorer">${igName}<span class="gt2-group-link-icon">↗</span></span>`,
            className: 'gt2-group',
            subgroupOrder: 'subgroup',
            // 'a-work' = WIP/PC, 'b-released' = solid line + diamonds,
            // 'c-branches' = repo branch overlay (one row per branch).
            subgroupStack: { 'a-work': false, 'b-released': false, 'c-branches': true }
        });

        const firstReleaseMs = pkg.timeline
            .filter(e => e.release)
            .map(e => new Date(e.release).getTime())
            .sort((a, b) => a - b)[0] || null;

        // Split the row into two vertical tracks only when BOTH line types
        // are present: dotted (WIP buildStart) and solid (release). Otherwise
        // keep the single line on the row's centre.
        const hasWip = pkg.timeline.some(e => e.buildStart);
        const splitTracks = hasWip && firstReleaseMs !== null;
        const wipClass = 'gt2-wip' + (splitTracks ? ' gt2-track-above' : '');
        const pcClass = 'gt2-pc' + (splitTracks ? ' gt2-track-above' : '');
        const pcLineClass = 'gt2-pc-line' + (splitTracks ? ' gt2-track-above' : '');
        const releasedClass = 'gt2-released' + (splitTracks ? ' gt2-track-below' : '');
        const diamondClass = 'gt2-release' + (splitTracks ? ' gt2-track-below' : '');

        // Continuous "released" segment — first release → today
        if (firstReleaseMs !== null) {
            items.push({
                id: ++itemId, group: pkg.name, subgroup: 'b-released', type: 'range',
                start: new Date(firstReleaseMs), end: today,
                className: releasedClass,
                style: `--ig-color:${color}`,
                title: `${pkg.shortName} — Released since ${formatDate(new Date(firstReleaseMs).toISOString())}`
            });
        }

        for (const entry of pkg.timeline) {
            const buildStartMs = entry.buildStart ? new Date(entry.buildStart).getTime() : null;
            const releaseMs = entry.release ? new Date(entry.release).getTime() : null;
            const pcStartMs = entry.publicComment ? new Date(entry.publicComment.start).getTime() : null;
            const pcEndMs = entry.publicComment ? new Date(entry.publicComment.end).getTime() : null;
            const rtpMs = entry.requestToPublish ? new Date(entry.requestToPublish).getTime() : null;
            const pcApproved = !!entry.publicComment && rtpMs !== null && rtpMs <= todayMs;
            const versionLabel = entry.version ? `v${entry.version}` : 'next';

            if (buildStartMs) {
                // Continuous WIP line from buildStart to release (or today). The
                // PC rectangle overlays this line rather than interrupting it —
                // workgroup discussion continues during the public comment window.
                const wipEnd = releaseMs || todayMs;
                if (wipEnd > buildStartMs) {
                    items.push({
                        id: ++itemId, group: pkg.name, subgroup: 'a-work', type: 'range',
                        start: new Date(buildStartMs), end: new Date(wipEnd),
                        className: wipClass,
                        style: `--ig-color:${color}`,
                        title: `${pkg.shortName} ${versionLabel} — Workgroup discussion (${formatDate(entry.buildStart)} → ${releaseMs ? formatDate(entry.release) : 'ongoing'})`
                    });
                }
                if (pcApproved) {
                    // Dashed line in PC colour — overlays the dotted WIP line during
                    // the public comment window so the line itself visibly changes
                    // character, not just the overlay rectangle.
                    items.push({
                        id: ++itemId, group: pkg.name, subgroup: 'a-work', type: 'range',
                        start: new Date(pcStartMs), end: new Date(pcEndMs),
                        className: pcLineClass,
                        title: `${pkg.shortName} ${versionLabel} — Public Comment: ${formatDate(entry.publicComment.start)} → ${formatDate(entry.publicComment.end)}`
                    });
                    // Translucent rectangle overlay on top of the dashed line
                    items.push({
                        id: ++itemId, group: pkg.name, subgroup: 'a-work', type: 'range',
                        start: new Date(pcStartMs), end: new Date(pcEndMs),
                        className: pcClass,
                        title: `${pkg.shortName} ${versionLabel} — Public Comment: ${formatDate(entry.publicComment.start)} → ${formatDate(entry.publicComment.end)}`
                    });
                }
            }

            if (releaseMs) {
                items.push({
                    id: ++itemId, group: pkg.name, subgroup: 'b-released', type: 'point',
                    start: new Date(releaseMs),
                    content: `<div class="gt2-rel-label">${versionLabel}</div>`,
                    className: diamondClass,
                    style: `--ig-color:${color}`,
                    title: `${pkg.shortName} ${versionLabel} — Released ${formatDate(entry.release)}`
                });
            }
        }

        // ── Branch overlay (from public/data/repos.yaml) ────────────────
        // For each `relevant: true` repo whose `repo:` matches this package's
        // configured repository, add one range item per non-default branch.
        // Item style is driven by the branch state (active / merged / diverged).
        if (showBranches && pkg.info && pkg.info.repository && data.repos) {
            const repoEntry = data.repos.find(r => r.relevant && r.repo === pkg.info.repository);
            if (repoEntry && Array.isArray(repoEntry.branches)) {
                // Find the default-branch entry and check whether main itself is
                // stale. If its head commit is older than 90 days, drop a warning
                // marker on today's position so it surfaces in the chart.
                const STALE_MAIN_DAYS = 90;
                const mainBranch = repoEntry.branches.find(b => b.name === repoEntry.defaultBranch);
                if (mainBranch && mainBranch.lastCommit) {
                    const lastMs = new Date(mainBranch.lastCommit).getTime();
                    const ageDays = Math.round((todayMs - lastMs) / (24 * 60 * 60 * 1000));
                    if (ageDays > STALE_MAIN_DAYS) {
                        items.push({
                            id: ++itemId, group: pkg.name, subgroup: 'c-branches', type: 'point',
                            start: new Date(lastMs),
                            className: 'gt2-main-stale',
                            content: `<span class="gt2-main-stale-label">⚠ main idle ${ageDays}d</span>`,
                            title: `<div style="font-weight:600;color:#111">${repoEntry.repo}#${repoEntry.defaultBranch}</div>
                                <div style="font-size:0.75rem;color:#b91c1c;margin-top:2px">Last commit ${ageDays} days ago — older than ${STALE_MAIN_DAYS}-day threshold</div>
                                <div style="font-size:0.75rem;color:#6b7280">Last commit: ${mainBranch.lastCommit.substring(0,10)}</div>`,
                            ghUrl: `https://github.com/${repoEntry.repo}/commits/${repoEntry.defaultBranch}`
                        });
                    }
                }

                for (const b of repoEntry.branches) {
                    if (b.name === repoEntry.defaultBranch) continue;
                    if (!b.divergedAt && !b.lastCommit) continue;
                    const startMs = b.divergedAt ? new Date(b.divergedAt).getTime() : new Date(b.lastCommit).getTime();
                    const isActive = b.state === 'ahead' || b.state === 'diverged';
                    const endMs = isActive ? todayMs : (b.lastCommit ? new Date(b.lastCommit).getTime() : todayMs);
                    if (endMs <= startMs) continue;
                    const branchUrl = `https://github.com/${repoEntry.repo}/tree/${encodeURIComponent(b.name)}`;
                    const lastCommitLabel = b.lastCommit ? b.lastCommit.substring(0, 10) : '';
                    const ageDays = b.lastCommit ? Math.round((todayMs - new Date(b.lastCommit).getTime()) / (24 * 60 * 60 * 1000)) : null;
                    // Rich HTML tooltip — vis-timeline renders item.title as HTML when
                    // it contains tags. Keep markup minimal so it parses reliably.
                    const tooltipHtml = `
                        <div style="font-weight:600;color:#111">${repoEntry.repo}#${b.name}</div>
                        <div style="font-size:0.75rem;color:#374151;margin-top:2px">${b.state} · ahead ${b.ahead || 0} · behind ${b.behind || 0}</div>
                        ${b.divergedAt ? `<div style="font-size:0.75rem;color:#6b7280">Diverged: ${b.divergedAt.substring(0,10)}</div>` : ''}
                        ${b.lastCommit ? `<div style="font-size:0.75rem;color:#6b7280">Last commit: ${lastCommitLabel}${ageDays != null ? ` (${ageDays}d ago)` : ''}</div>` : ''}
                        <div style="font-size:0.6875rem;color:#2563eb;margin-top:4px">Click to open on GitHub</div>`;
                    // Inline label rendered on the line itself: branch name + last-commit date.
                    // For branches more advanced than main (ahead / diverged) prepend an
                    // ↑N badge so the "how far ahead" reading is immediate.
                    const isAdvanced = (b.state === 'ahead' || b.state === 'diverged') && (b.ahead || 0) > 0;
                    const aheadBadge = isAdvanced ? `<span class="gt2-branch-ahead-badge">↑${b.ahead}</span> ` : '';
                    const inlineLabel = `<span class="gt2-branch-label">${aheadBadge}${b.name}${lastCommitLabel ? ` · ${lastCommitLabel}` : ''}</span>`;
                    items.push({
                        id: ++itemId, group: pkg.name, subgroup: 'c-branches', type: 'range',
                        start: new Date(startMs), end: new Date(endMs),
                        className: `gt2-branch gt2-branch-${b.state}`,
                        content: inlineLabel,
                        title: tooltipHtml,
                        ghUrl: branchUrl,
                        repoBranch: `${repoEntry.repo}#${b.name}`
                    });
                    items.push({
                        id: ++itemId, group: pkg.name, subgroup: 'c-branches', type: 'point',
                        start: new Date(startMs),
                        className: `gt2-branch-marker gt2-branch-marker-start gt2-branch-${b.state}`,
                        title: `${repoEntry.repo}#${b.name} branched off`
                    });
                    items.push({
                        id: ++itemId, group: pkg.name, subgroup: 'c-branches', type: 'point',
                        start: new Date(endMs),
                        className: `gt2-branch-marker gt2-branch-marker-end gt2-branch-${b.state}`,
                        title: isActive ? `${repoEntry.repo}#${b.name} still active` : `${repoEntry.repo}#${b.name} merged`
                    });
                }
            }
        }
    });

    // ── Render shell ────────────────────────────────────────────────
    container.innerHTML = `
        <div class="gt2-legend" style="display:flex;gap:1.25rem;align-items:center;padding:0.5rem 0.75rem 0.75rem;font-size:0.8125rem;color:var(--gray-700);flex-wrap:wrap">
            <span style="font-weight:600">Legend:</span>
            <div style="display:flex;gap:0.375rem;align-items:center"><div style="width:24px;border-top:2.5px dotted #2563eb"></div><span>Workgroup discussion</span></div>
            <div style="display:flex;gap:0.375rem;align-items:center"><div style="width:24px;border-top:2.5px dashed ${pcColor}"></div><span>Public Comment</span></div>
            <div style="display:flex;gap:0.375rem;align-items:center"><div style="width:24px;border-top:2.5px solid #2563eb;opacity:0.75"></div><span>Released</span></div>
            <div style="display:flex;gap:0.375rem;align-items:center"><span style="color:#2563eb">◆</span><span>Release</span></div>
            <div style="display:flex;gap:0.375rem;align-items:center"><div style="width:24px;border-top:2.5px solid #16a34a"></div><span>Active branch</span></div>
            <div style="display:flex;gap:0.375rem;align-items:center"><div style="width:24px;border-top:2.5px solid #9ca3af;opacity:0.6"></div><span>Merged branch</span></div>
            <div style="display:flex;gap:0.375rem;align-items:center"><div style="width:24px;border-top:2px dashed var(--danger)"></div><span>Today</span></div>
            <label style="margin-left:auto;display:flex;gap:0.375rem;align-items:center;cursor:pointer">
                <input type="checkbox" ${showBranches ? 'checked' : ''} onchange="toggleShowBranches(this)">
                <span>Show branches</span>
            </label>
        </div>
        <div id="gt2-host" style="background:white;border:1px solid var(--gray-200);border-radius:0.5rem;padding:0.5rem"></div>
    `;

    const host = document.getElementById('gt2-host');
    const options = {
        stack: false,
        stackSubgroups: true,
        editable: false,
        margin: { item: 6, axis: 8 },
        orientation: { axis: 'top', item: 'top' },
        zoomMin: 1000 * 60 * 60 * 24 * 30,       // 30 days
        zoomMax: 1000 * 60 * 60 * 24 * 365 * 10, // 10 years
        showCurrentTime: true,
        tooltip: { followMouse: true },
        // Allow the release-diamond content to render our nested <div> label
        template: function (item, element, data) {
            return item && item.content ? item.content : '';
        }
    };
    const tl = new Timeline(host, new DataSet(items), new DataSet(groups), options);

    // Clicking a group label (left column) jumps to that package in the Explorer.
    // Clicking a branch range opens its GitHub URL in a new tab.
    tl.on('click', function (props) {
        if (props && props.what === 'group-label' && props.group) {
            jumpToPackageInExplorer(props.group);
            return;
        }
        if (props && props.item != null) {
            const allItems = tl.itemsData ? tl.itemsData.get() : [];
            const item = allItems.find(i => i.id === props.item);
            if (item && item.ghUrl) window.open(item.ghUrl, '_blank', 'noopener');
        }
    });

    // Fit the whole span with a bit of padding
    if (items.length > 0) {
        const starts = items.map(i => new Date(i.start).getTime());
        const ends = items.map(i => new Date(i.end || i.start).getTime());
        const min = Math.min(...starts, todayMs);
        const max = Math.max(...ends, todayMs);
        const pad = (max - min) * 0.03;
        tl.setWindow(new Date(min - pad), new Date(max + pad), { animation: false });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTROLS — quality & monitoring checks framework.
//
// Separation of concerns:
//   - METADATA (name, description, category, severity, enabled, params) lives
//     in public/data/controls.yaml — edit it to tune the UI without touching JS.
//   - LOGIC (the `check` function) is registered here by id.
//
// Result contract for a check:
//   {
//     status:   'pass' | 'fail' | 'na' | 'not-implemented'
//     summary:  short one-liner shown on the status badge when failing
//     findings: [{ label, link, drillTo }]    -- used by the expand panel
//   }
// A `finding.drillTo` is a callback invoked when the user clicks the finding;
// use it to jump to a filtered view (Explorer, Artifacts, …) so the user can
// see *what* is flagged, not just the count.
// ═══════════════════════════════════════════════════════════════════════════

window._controlChecks = window._controlChecks || {};
function registerControl(id, checkFn) {
    if (!id || typeof checkFn !== 'function') return;
    window._controlChecks[id] = checkFn;
}

// ── Check implementations ──────────────────────────────────────────────────
// Each check reads data + params and returns a result. Keep checks small;
// heavy work should be memoised or computed from pre-indexed data.
//
// Example: ValueSets containing at least one inactive concept. Findings link
// into the Explorer's Artifacts view filtered to the specific valueset id.

registerControl('vs-inactive-concepts', function (data, params) {
    const results = [];
    // The crawler stores inactive counts under artifact metadata when a
    // terminology server expansion is available. If we don't have that data
    // yet, report 'not implemented' so the user understands why.
    const meta = data.artifactMeta || {};
    if (Object.keys(meta).length === 0) {
        return { status: 'not-implemented', summary: 'Run Crawl with TX expansion enabled' };
    }
    for (const [key, m] of Object.entries(meta)) {
        if (m && typeof m.txInactiveCount === 'number' && m.txInactiveCount > 0) {
            const [id] = key.split('|');
            results.push({
                label: `${id} (${m.txInactiveCount} inactive)`,
                drillTo: () => jumpToArtifact(id)
            });
        }
    }
    return {
        status: results.length ? 'fail' : 'pass',
        summary: results.length ? `${results.length} valueset${results.length === 1 ? '' : 's'}` : null,
        findings: results
    };
});

// Jump to the Explorer's Artifacts sub-view and scroll to a specific id.
// Used by control findings to let the user drill into the flagged artifacts.
function jumpToArtifact(artifactId) {
    explorerMode = 'artifacts';
    switchView('explorer');
    setTimeout(() => {
        const row = [...document.querySelectorAll('.exp-art-row, td')]
            .find(el => el.textContent.includes(artifactId));
        if (row) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.style.transition = 'background 0.3s';
            row.style.background = 'var(--warning-light)';
            setTimeout(() => { row.style.background = ''; }, 1500);
        }
    }, 80);
}

// ── Governance checks ─────────────────────────────────────────────────────────

// Business document sent to WGSE — flags any approved/published document
// version (in `document` or `businessDocuments`) whose `sentToWGSE` date
// is not set. Catches both "never sent" and "doc updated, new version not
// re-sent" cases because each version tracks its own sentToWGSE independently.
registerControl('doc-sent-to-wgse', function (data, params) {
    const requireFor = new Set((params && params.requireForStatuses) || ['approved', 'published']);
    const findings = [];
    for (const cs of (data.caresets || [])) {
        for (const d of (cs.deliveries || [])) {
            // Check the single `document` field
            if (d.document && requireFor.has(d.document.status) && !d.document.sentToWGSE) {
                findings.push({
                    label: `${cs.name} v${d.version} — document v${d.document.version || '?'} ${d.document.status} but not sent to WGSE`,
                    drillTo: () => jumpToPackageInExplorer(cs.project)
                });
            }
            // Check each entry in `businessDocuments` (versioned list)
            for (const bd of (d.businessDocuments || [])) {
                if (requireFor.has(bd.status) && !bd.sentToWGSE) {
                    findings.push({
                        label: `${cs.name} v${d.version} — "${bd.title || 'Business doc'}" v${bd.version || '?'} ${bd.status} but not sent to WGSE`,
                        drillTo: () => jumpToPackageInExplorer(cs.project)
                    });
                }
            }
        }
    }
    return {
        status: findings.length ? 'fail' : 'pass',
        summary: findings.length ? `${findings.length} not sent` : null,
        findings
    };
});

// ── Build-status checks (read from registry-cache.json's ciBuilds / branches) ─

// CI master build is OK — uses the qa.json's `errs` count. Fails when any IG
// has more errors than `params.maxErrors` (default 0).
registerControl('ci-build-ok', function (data, params) {
    const builds = data.ciBuilds || {};
    if (Object.keys(builds).length === 0) {
        return { status: 'not-implemented', summary: 'Run npm run fetch:registry' };
    }
    const threshold = (params && typeof params.maxErrors === 'number') ? params.maxErrors : 0;
    const bad = [];
    for (const [id, b] of Object.entries(builds)) {
        if (!b.fetchedOk) {
            bad.push({ label: `${id} — qa.json unreachable (${b.error || '?'})`, drillTo: () => jumpToPackageInExplorer(id) });
            continue;
        }
        if (typeof b.errors === 'number' && b.errors > threshold) {
            bad.push({
                label: `${id} v${b.version || '?'} — ${b.errors} error${b.errors === 1 ? '' : 's'}, ${b.warnings ?? '?'} warning${b.warnings === 1 ? '' : 's'}`,
                link: b.url,
                drillTo: () => jumpToPackageInExplorer(id)
            });
        }
    }
    return {
        status: bad.length ? 'fail' : 'pass',
        summary: bad.length ? `${bad.length} IG${bad.length === 1 ? '' : 's'} failing` : null,
        findings: bad
    };
});

// CI Build URL publishes a qa.json — fails when the build-time probe couldn't
// fetch qa.json for an IG that has an igUrl configured.
registerControl('ci-has-qa-json', function (data, params) {
    const builds = data.ciBuilds || {};
    if (Object.keys(builds).length === 0) {
        return { status: 'not-implemented', summary: 'Run npm run fetch:registry' };
    }
    const missing = [];
    for (const [id, b] of Object.entries(builds)) {
        if (!b.fetchedOk) {
            missing.push({ label: `${id} — ${b.url} (${b.error || 'unreachable'})`, drillTo: () => jumpToPackageInExplorer(id) });
        }
    }
    return {
        status: missing.length ? 'fail' : 'pass',
        summary: missing.length ? `${missing.length} missing` : null,
        findings: missing
    };
});

// Long-standing branches — branches older than `params.maxAgeDays` (default 90).
// `params.ignoreBranches` is a list of branch names to skip (main / master …).
registerControl('long-standing-branches', function (data, params) {
    const br = data.branches || {};
    if (Object.keys(br).length === 0) {
        return { status: 'not-implemented', summary: 'Run npm run fetch:registry (needs GITHUB_TOKEN)' };
    }
    const maxAgeMs = ((params && params.maxAgeDays) || 90) * 24 * 60 * 60 * 1000;
    const ignore = new Set((params && params.ignoreBranches) || ['main', 'master', 'gh-pages']);
    const now = Date.now();
    const stale = [];
    for (const [id, entry] of Object.entries(br)) {
        if (!entry.fetchedOk) continue;
        for (const b of (entry.branches || [])) {
            if (ignore.has(b.name)) continue;
            if (!b.commitDate) continue;   // no date → can't judge, skip
            const age = now - new Date(b.commitDate).getTime();
            if (age > maxAgeMs) {
                const days = Math.round(age / (24 * 60 * 60 * 1000));
                stale.push({
                    label: `${id}#${b.name} — ${days}d old (${b.commitDate.substring(0, 10)})`,
                    link: `https://github.com/${entry.repo}/tree/${b.name}`,
                    drillTo: () => jumpToPackageInExplorer(id)
                });
            }
        }
    }
    return {
        status: stale.length ? 'fail' : 'pass',
        summary: stale.length ? `${stale.length} stale branch${stale.length === 1 ? '' : 'es'}` : null,
        findings: stale
    };
});

// Cache for findings so the drill-down buttons can look them up by index
// without re-running checks. Populated fresh on each render.
window._controlFindings = window._controlFindings || {};

function renderHealth() {
    const defs = (data.controls || []).filter(c => c && c.id && c.enabled !== false);

    let html = '';

    if (defs.length === 0) {
        html += '<div class="card"><div class="card-body" style="color:var(--gray-400);padding:2rem;text-align:center">No controls defined. Add entries to <code>controls.yaml</code>.</div></div>';
        document.getElementById('viewContent').innerHTML = html;
        return;
    }

    const severityOrder = { error: 0, warn: 1, info: 2 };
    const sevBadge = (sev) => {
        const color = sev === 'error' ? 'var(--danger)' : sev === 'warn' ? 'var(--warning)' : 'var(--gray-500)';
        const bg = sev === 'error' ? 'var(--danger-light)' : sev === 'warn' ? 'var(--warning-light)' : 'var(--gray-100)';
        return `<span class="badge" style="background:${bg};color:${color}">${sev || 'info'}</span>`;
    };
    const statusBadge = (status, summary) => {
        if (status === 'pass')   return `<span class="badge badge-published">pass</span>`;
        if (status === 'fail')   return `<span class="badge" style="background:var(--danger-light);color:var(--danger)">${summary || 'fail'}</span>`;
        if (status === 'na')     return `<span class="badge badge-planned">n/a</span>`;
        return `<span class="badge badge-planned">not implemented</span>`;
    };

    // Merge YAML metadata with registered check functions
    const checks = window._controlChecks || {};
    const controls = defs.map(def => {
        const checkFn = checks[def.id];
        let result = { status: 'not-implemented', summary: null, findings: [] };
        if (typeof checkFn === 'function') {
            try { result = checkFn(data, def.params || {}) || result; }
            catch (e) { result = { status: 'fail', summary: 'error: ' + e.message, findings: [] }; }
        }
        return { def, result };
    });

    // Cache findings keyed by control id so onclick handlers can retrieve them
    window._controlFindings = {};
    for (const c of controls) window._controlFindings[c.def.id] = c.result.findings || [];

    // ── Dashboard summary ─────────────────────────────────────────────
    // Aggregate status counts across all controls so the user gets an
    // at-a-glance health picture before drilling into categories.
    const counts = { pass: 0, fail: 0, na: 0, notImplemented: 0, failErrors: 0, failWarnings: 0 };
    for (const { def, result } of controls) {
        if (result.status === 'pass') counts.pass++;
        else if (result.status === 'fail') {
            counts.fail++;
            if (def.severity === 'error') counts.failErrors++;
            else counts.failWarnings++;
        }
        else if (result.status === 'na') counts.na++;
        else counts.notImplemented++;
    }

    const overall = counts.failErrors > 0 ? 'error'
        : counts.failWarnings > 0 ? 'warn'
        : counts.pass > 0 ? 'healthy'
        : 'unknown';
    const overallColor = { error: 'var(--danger)', warn: 'var(--warning)', healthy: 'var(--success)', unknown: 'var(--gray-400)' }[overall];
    const overallLabel = { error: 'Attention needed', warn: 'Minor issues', healthy: 'Healthy', unknown: 'Not measured' }[overall];

    html += `
        <div class="card" style="margin-bottom:1rem;border-left:4px solid ${overallColor}">
            <div class="card-body" style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap">
                <div>
                    <div style="font-size:0.75rem;text-transform:uppercase;color:var(--gray-500);letter-spacing:0.05em">Overall status</div>
                    <div style="font-size:1.5rem;font-weight:700;color:${overallColor}">${overallLabel}</div>
                </div>
                <div style="flex:1;color:var(--gray-600);font-size:0.875rem">
                    ${defs.length} checks registered${counts.notImplemented > 0 ? ` · ${counts.notImplemented} not yet implemented` : ''}.
                    Configuration in <code>public/data/controls.yaml</code>.
                </div>
            </div>
        </div>
        <div class="stats-row">
            <div class="stat-card" style="border-left:3px solid var(--success)">
                <div class="stat-value" style="color:var(--success)">${counts.pass}</div>
                <div class="stat-label">Passing</div>
            </div>
            <div class="stat-card" style="border-left:3px solid var(--danger)">
                <div class="stat-value" style="color:var(--danger)">${counts.failErrors}</div>
                <div class="stat-label">Failing (error)</div>
            </div>
            <div class="stat-card" style="border-left:3px solid var(--warning)">
                <div class="stat-value" style="color:var(--warning)">${counts.failWarnings}</div>
                <div class="stat-label">Failing (warning)</div>
            </div>
            <div class="stat-card" style="border-left:3px solid var(--gray-400)">
                <div class="stat-value" style="color:var(--gray-500)">${counts.notImplemented}</div>
                <div class="stat-label">Not yet implemented</div>
            </div>
        </div>
    `;

    const byCategory = {};
    for (const c of controls) {
        const cat = c.def.category || 'Uncategorised';
        (byCategory[cat] = byCategory[cat] || []).push(c);
    }

    for (const cat of Object.keys(byCategory).sort()) {
        const rows = byCategory[cat].sort((a, b) =>
            (severityOrder[a.def.severity] ?? 9) - (severityOrder[b.def.severity] ?? 9));
        html += `<div class="card">
            <div class="card-header">${cat}</div>
            <div class="card-body" style="padding:0">
                <table>
                    <thead><tr>
                        <th style="width:30%">Control</th>
                        <th>Description</th>
                        <th style="width:8rem">Severity</th>
                        <th style="width:14rem">Status</th>
                    </tr></thead>
                    <tbody>`;
        for (const { def, result } of rows) {
            const findings = result.findings || [];
            const hasFindings = result.status === 'fail' && findings.length > 0;
            const hasLink = !!def.link;
            // Row click behaviour: prefer the YAML-declared link, otherwise fall
            // back to expanding findings. Users can still open the findings list
            // via the 'findings' chip in the status column when a link is set.
            let rowOnclick = '';
            if (hasLink) {
                rowOnclick = ` onclick="followControlLink('${def.link}')" class="clickable"`;
            } else if (hasFindings) {
                rowOnclick = ` onclick="toggleControlFindings('${def.id}', this)" class="clickable"`;
            }
            const statusExtra = hasLink
                ? ` <span class="gt2-link-icon" title="Open ${def.link}">↗</span>`
                : hasFindings
                    ? ` <a href="#" onclick="event.preventDefault();event.stopPropagation();toggleControlFindings('${def.id}', this.closest('tr'))" style="color:var(--gray-500);font-size:0.75rem;margin-left:0.375rem;text-decoration:underline">${findings.length} findings</a>`
                    : '';
            html += `<tr${rowOnclick}>
                <td><strong>${def.name}</strong></td>
                <td style="color:var(--gray-600);font-size:0.8125rem">${def.description || ''}</td>
                <td>${sevBadge(def.severity)}</td>
                <td>${statusBadge(result.status, result.summary)}${statusExtra}</td>
            </tr>
            <tr class="gt2-findings-row" style="display:none" data-control="${def.id}">
                <td colspan="4" style="background:var(--gray-50);padding:0.75rem 1.25rem">
                    <div style="font-size:0.8125rem;color:var(--gray-600);margin-bottom:0.5rem"><strong>Findings</strong> (${findings.length}):</div>
                    <ul style="list-style:none;padding-left:0;margin:0;max-height:240px;overflow-y:auto">
                        ${findings.map((f, idx) => `
                            <li style="padding:0.25rem 0;font-size:0.8125rem">
                                ${f.drillTo ? `<a href="#" onclick="event.preventDefault();event.stopPropagation();runControlFinding('${def.id}', ${idx})" style="color:var(--primary);text-decoration:underline">${f.label}</a>` : f.label}
                                ${f.link ? ` <a href="${f.link}" target="_blank" style="color:var(--gray-500);font-size:0.75rem;margin-left:0.5rem">↗</a>` : ''}
                            </li>
                        `).join('')}
                    </ul>
                </td>
            </tr>`;
        }
        html += `</tbody></table></div></div>`;
    }

    document.getElementById('viewContent').innerHTML = html;
}

function toggleControlFindings(controlId, rowEl) {
    const findingsRow = rowEl.parentElement.querySelector(`tr.gt2-findings-row[data-control="${controlId}"]`);
    if (findingsRow) findingsRow.style.display = findingsRow.style.display === 'none' ? 'table-row' : 'none';
}

function runControlFinding(controlId, index) {
    const findings = (window._controlFindings || {})[controlId] || [];
    const f = findings[index];
    if (f && typeof f.drillTo === 'function') f.drillTo();
}

// Navigate from a Health control to the view declared in its `link` field.
// Supported shapes:
//   reports/valuesets   reports/codesystems   reports/namingsystems
//   reports/profiles    reports/type/<type>   reports/package/<pkg>
//   reports/layer/<L2|T|L3>
//   explorer/packages   explorer/artifacts    pipeline    timeline
function followControlLink(link) {
    if (!link) return;
    const parts = link.split('/');
    const head = parts[0];
    if (head === 'reports') {
        switchView('reports');
        setTimeout(() => {
            const what = parts[1];
            const filter = parts.slice(2).join('/');
            if (what === 'layer' || what === 'type' || what === 'package') {
                showReport(what, filter);
            } else if (what) {
                showReport(what);
            }
        }, 30);
    } else if (head === 'explorer') {
        explorerMode = parts[1] || 'packages';
        switchView('explorer');
    } else {
        switchView(head);  // pipeline, timeline, gaps, health, etc.
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUPS — workgroup overview / health.
// Each group owns N IGs (linked via `owner: <group-id>` in active-igs.yaml).
// Sources (governance artifacts): public/data/groups.yaml + active-igs.yaml.
// ═══════════════════════════════════════════════════════════════════════════
function renderGroups() {
    const container = document.getElementById('viewContent');
    const groups = data.groups || [];
    const activeIGs = data.activeIGs || [];

    if (groups.length === 0) {
        container.innerHTML = '<div class="card"><div class="card-body" style="color:var(--gray-400);padding:2rem;text-align:center">No groups defined. Add entries to <code>public/data/groups.yaml</code>.</div></div>';
        return;
    }

    // Index IGs by owner group id; collect orphans (no owner set)
    const igsByOwner = {};
    const orphaned = [];
    for (const ig of activeIGs) {
        if (ig.owner) (igsByOwner[ig.owner] = igsByOwner[ig.owner] || []).push(ig);
        else orphaned.push(ig);
    }

    // Per-IG status snapshot used inside each group card
    function igStatus(ig) {
        const proj = (data.projects || []).find(p => p.repository === ig.repo);
        const repoEntry = (data.repos || []).find(r => r.repo === ig.repo);
        const mainBranch = repoEntry && repoEntry.branches && repoEntry.branches.find(b => b.name === repoEntry.defaultBranch);
        let mainStaleDays = null;
        if (mainBranch && mainBranch.lastCommit) {
            mainStaleDays = Math.round((Date.now() - new Date(mainBranch.lastCommit).getTime()) / 86400000);
        }
        return {
            projectStatus: proj ? proj.status : null,
            branchSummary: repoEntry ? repoEntry.branchSummary : null,
            mainStaleDays
        };
    }

    // ── Top-of-page summary across all groups ──────────────────────────
    let totalIGs = 0, wipIGs = 0, publishedIGs = 0, staleMains = 0, activeBranches = 0;
    for (const g of groups) {
        for (const ig of (igsByOwner[g.id] || [])) {
            const st = igStatus(ig);
            totalIGs++;
            if (st.projectStatus === 'wip' || st.projectStatus === 'draft') wipIGs++;
            else if (st.projectStatus === 'published') publishedIGs++;
            if (st.mainStaleDays != null && st.mainStaleDays > 90) staleMains++;
            if (st.branchSummary) activeBranches += (st.branchSummary.active || 0);
        }
    }

    let html = '<div class="stats-row">'
        + '<div class="stat-card"><div class="stat-value">' + groups.length + '</div><div class="stat-label">Groups</div></div>'
        + '<div class="stat-card"><div class="stat-value">' + totalIGs + '</div><div class="stat-label">IGs governed</div></div>'
        + '<div class="stat-card" style="border-left:3px solid var(--success)"><div class="stat-value" style="color:var(--success)">' + publishedIGs + '</div><div class="stat-label">Published</div></div>'
        + '<div class="stat-card" style="border-left:3px solid var(--warning)"><div class="stat-value" style="color:var(--warning)">' + wipIGs + '</div><div class="stat-label">WIP</div></div>'
        + '<div class="stat-card" style="border-left:3px solid var(--danger)"><div class="stat-value" style="color:var(--danger)">' + staleMains + '</div><div class="stat-label">Stale main branches</div></div>'
        + '<div class="stat-card"><div class="stat-value">' + activeBranches + '</div><div class="stat-label">Active feature branches</div></div>'
        + '</div>';

    if (orphaned.length > 0) {
        html += '<div class="card" style="margin-bottom:1rem;border-left:4px solid var(--warning)"><div class="card-body" style="font-size:0.875rem">'
            + '<strong>' + orphaned.length + ' active IG' + (orphaned.length === 1 ? '' : 's') + ' without an owner group:</strong> '
            + orphaned.map(o => '<code style="margin-right:0.5rem">' + o.repo + '</code>').join('')
            + '<div style="color:var(--gray-500);margin-top:0.25rem">Set <code>owner: &lt;group-id&gt;</code> in <code>active-igs.yaml</code>.</div>'
            + '</div></div>';
    }

    for (const g of groups) {
        const owned = igsByOwner[g.id] || [];
        const lastMeetingAge = g.lastMeeting ? Math.round((Date.now() - new Date(g.lastMeeting).getTime()) / 86400000) : null;

        html += '<div class="card"><div class="card-header" style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap">'
            + '<div><strong style="font-size:1rem">' + g.name + '</strong>'
            + (g.chair ? '<span style="color:var(--gray-500);font-size:0.8125rem;margin-left:0.5rem">chair: ' + g.chair + '</span>' : '')
            + '</div><div style="display:flex;gap:0.75rem;align-items:center;font-size:0.8125rem;color:var(--gray-600)">'
            + (g.meetingCadence ? '<span>📅 ' + g.meetingCadence + '</span>' : '')
            + (g.lastMeeting ? '<span title="' + g.lastMeeting + '">last meeting: ' + lastMeetingAge + 'd ago</span>' : '<span style="color:var(--gray-400)">no meeting recorded</span>')
            + '</div></div><div class="card-body">'
            + (g.description ? '<div style="color:var(--gray-600);font-size:0.875rem;margin-bottom:0.75rem">' + g.description + '</div>' : '')
            + '<div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--gray-500);margin-bottom:0.5rem">'
            + owned.length + ' IG' + (owned.length === 1 ? '' : 's') + ' owned</div>';

        if (owned.length === 0) {
            html += '<div style="color:var(--gray-400);font-size:0.8125rem">No IGs assigned. Set <code>owner: ' + g.id + '</code> on entries in <code>active-igs.yaml</code>.</div>';
        } else {
            html += '<table><thead><tr>'
                + '<th style="width:30%">Repo</th><th>Description</th><th style="width:8rem">Status</th>'
                + '<th style="width:12rem">Main branch</th><th style="width:10rem">Active branches</th>'
                + '</tr></thead><tbody>';
            for (const ig of owned) {
                const st = igStatus(ig);
                const projBadge = st.projectStatus
                    ? '<span class="badge badge-' + st.projectStatus + '">' + st.projectStatus + '</span>'
                    : '<span class="badge badge-planned">unknown</span>';
                const mainCell = st.mainStaleDays == null
                    ? '<span style="color:var(--gray-400)">—</span>'
                    : (st.mainStaleDays > 90
                        ? '<span style="color:var(--danger);font-weight:600">⚠ ' + st.mainStaleDays + 'd idle</span>'
                        : '<span style="color:var(--gray-600)">' + st.mainStaleDays + 'd ago</span>');
                const branchCell = st.branchSummary
                    ? '<span title="' + st.branchSummary.total + ' total branches">' + (st.branchSummary.active || 0) + ' active'
                        + (st.branchSummary.mergedStale ? ' · ' + st.branchSummary.mergedStale + ' stale' : '') + '</span>'
                    : '<span style="color:var(--gray-400)">no data</span>';
                html += '<tr style="cursor:pointer" onclick="jumpToPackageInExplorer(\'' + (ig.package || '') + '\')">'
                    + '<td><code style="font-size:0.8125rem">' + ig.repo + '</code></td>'
                    + '<td style="color:var(--gray-600);font-size:0.8125rem">' + (ig.description || '') + '</td>'
                    + '<td>' + projBadge + '</td>'
                    + '<td>' + mainCell + '</td>'
                    + '<td>' + branchCell + '</td>'
                    + '</tr>';
            }
            html += '</tbody></table>';
        }
        html += '</div></div>';
    }

    container.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════
// BRANCH ACTIVITY — git-graph style diagram per relevant repo, for branch
// cleanup. Each repo card shows main as a horizontal line, with non-default
// branches drawn as curves splitting off at their divergence point and either
// curving back (merged) or extending with an open dot (still active).
// Click any branch to open it on GitHub.
// Source: public/data/repos.yaml + active-igs.yaml (only `relevant: true` repos).
// ═══════════════════════════════════════════════════════════════════════════
function renderBranches() {
    const container = document.getElementById('viewContent');
    const repos = (data.repos || []).filter(r => r.relevant && Array.isArray(r.branches) && r.branches.length > 0);

    if (repos.length === 0) {
        container.innerHTML = '<div class="card"><div class="card-body" style="color:var(--gray-400);padding:2rem;text-align:center">'
            + 'No relevant repos with branch data. Run <code>npm run discover:repos</code> and ensure entries are in <code>active-igs.yaml</code>.'
            + '</div></div>';
        return;
    }

    // Aggregate stats across all repos
    const STALE_DAYS = 90;
    const todayMs = Date.now();
    let totalBranches = 0, activeBranches = 0, mergedStale = 0, staleMains = 0;
    for (const r of repos) {
        for (const b of r.branches) {
            if (b.name === r.defaultBranch) {
                if (b.lastCommit) {
                    const age = (todayMs - new Date(b.lastCommit).getTime()) / 86400000;
                    if (age > STALE_DAYS) staleMains++;
                }
                continue;
            }
            totalBranches++;
            if (b.state === 'ahead' || b.state === 'diverged') activeBranches++;
            else if (b.state === 'merged-and-stale') mergedStale++;
        }
    }

    const staleLabel = showStaleBranches ? 'Merged &amp; stale (shown)' : 'Merged &amp; stale (hidden)';
    let html = '<div class="stats-row">'
        + '<div class="stat-card"><div class="stat-value">' + repos.length + '</div><div class="stat-label">Repos tracked</div></div>'
        + '<div class="stat-card"><div class="stat-value">' + totalBranches + '</div><div class="stat-label">Feature branches</div></div>'
        + '<div class="stat-card" style="border-left:3px solid var(--success)"><div class="stat-value" style="color:var(--success)">' + activeBranches + '</div><div class="stat-label">Active</div></div>'
        + '<div class="stat-card" style="border-left:3px solid var(--gray-400);' + (showStaleBranches ? '' : 'opacity:0.65') + '"><div class="stat-value" style="color:var(--gray-500)">' + mergedStale + '</div><div class="stat-label">' + staleLabel + '</div></div>'
        + '<div class="stat-card" style="border-left:3px solid var(--danger)"><div class="stat-value" style="color:var(--danger)">' + staleMains + '</div><div class="stat-label">Stale main branches</div></div>'
        + '</div>'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;gap:0.75rem;flex-wrap:wrap">'
        +   '<div style="font-size:0.8125rem;color:var(--gray-600)">'
        +     'Operational view for branch cleanup. Click any branch to open on GitHub. '
        +     'Branches with <code style="color:var(--gray-500)">merged-and-stale</code> state are safe to delete.'
        +   '</div>'
        +   '<div style="display:flex;gap:0.75rem;align-items:center">'
        +     '<label style="display:flex;gap:0.375rem;align-items:center;font-size:0.8125rem;color:var(--gray-700);cursor:pointer">'
        +       '<input type="checkbox" ' + (showStaleBranches ? 'checked' : '') + ' onchange="toggleShowStaleBranches(this)">'
        +       '<span>Show stale branches</span>'
        +     '</label>'
        +     '<button class="btn btn-sm btn-ghost" onclick="toggleAllBranchCards(true)">Expand all</button>'
        +     '<button class="btn btn-sm btn-ghost" onclick="toggleAllBranchCards(false)">Collapse all</button>'
        +   '</div>'
        + '</div>';

    // Render one git-graph SVG per repo
    for (const r of repos) {
        html += renderBranchGraph(r, todayMs);
    }

    container.innerHTML = html;

    // Wire click handlers (delegated)
    container.querySelectorAll('.gt2-bg-branch[data-href]').forEach(el => {
        el.addEventListener('click', () => window.open(el.getAttribute('data-href'), '_blank', 'noopener'));
    });

    // Custom SVG renderer is the active one (with proportional time axis).
    // gitgraph.js attempt was deferred because it lacks a real time scale.
    // To re-try gitgraph, uncomment the line below.
    // renderGitgraphsForBranchCards();
}

// Build one SVG card showing main + branches for a single repo.
function renderBranchGraph(repo, todayMs) {
    const STALE_DAYS = 90;
    const mainBranch = repo.branches.find(b => b.name === repo.defaultBranch);

    // Strict filter: keep only branches we can actually DRAW (need a usable
    // start *and* end). Skipping unrenderable branches up-front means no
    // phantom empty rows in the layout. Optionally hide merged-and-stale
    // branches based on the global `showStaleBranches` toggle. `identical`
    // branches are always hidden — they're literally main, no signal.
    const branches = repo.branches.filter(b => {
        if (b.name === repo.defaultBranch) return false;
        if (b.state === 'identical') return false;
        if (!showStaleBranches && b.state === 'merged-and-stale') return false;
        const start = b.divergedAt ? new Date(b.divergedAt).getTime() : (b.lastCommit ? new Date(b.lastCommit).getTime() : null);
        const isActive = b.state === 'ahead' || b.state === 'diverged';
        const end = isActive ? todayMs : (b.lastCommit ? new Date(b.lastCommit).getTime() : null);
        // Allow zero-span branches through: discover-repos sets divergedAt ===
        // lastCommit for most merged-and-stale branches, so a strict end > start
        // filter would silently drop hundreds of merged branches and make the
        // per-repo "N branches" count match "N active". The short-span fallback
        // in the draw loop renders these as a vertical tick.
        if (start == null || end == null || end < start) return false;
        return true;
    });

    // Sort: NEWEST divergence first → drawn at i=0 → closest to main (bottom).
    // OLDEST divergence last → drawn at i=N-1 → highest above main (top).
    // Visually, an old branch's curve lifts up from main far to the left and
    // stays at the top; younger branches sit between it and main, so their
    // upward curves never have to cross the older branch's horizontal line.
    branches.sort((a, b) => new Date(b.divergedAt || 0).getTime() - new Date(a.divergedAt || 0).getTime());

    if (branches.length === 0 && !mainBranch) return '';

    // Compute time range
    let minMs = todayMs;
    if (mainBranch && mainBranch.lastCommit) minMs = Math.min(minMs, new Date(mainBranch.lastCommit).getTime());
    let latestActivityMs = mainBranch && mainBranch.lastCommit ? new Date(mainBranch.lastCommit).getTime() : 0;
    for (const b of branches) {
        if (b.divergedAt) minMs = Math.min(minMs, new Date(b.divergedAt).getTime());
        if (b.lastCommit) {
            minMs = Math.min(minMs, new Date(b.lastCommit).getTime());
            latestActivityMs = Math.max(latestActivityMs, new Date(b.lastCommit).getTime());
        }
    }
    const padMs = 30 * 86400000;
    minMs -= padMs;
    // If everything (main + branches) is idle by a wide margin, clip the
    // right edge to the last-activity date + pad. Otherwise the chart wastes
    // most of its width on dashed/empty space and crams real activity into a
    // narrow strip on the left.
    const IDLE_CLIP_DAYS = 90;
    const idleClipMs = IDLE_CLIP_DAYS * 86400000;
    const maxMs = (latestActivityMs && (todayMs - latestActivityMs) > idleClipMs)
        ? latestActivityMs + padMs
        : todayMs + padMs;
    const range = maxMs - minMs;
    if (range <= 0) return '';

    // Layout — tight rows; height now matches rendered branch count exactly.
    const padX = 12;
    const labelW = 220;
    const width = 1200;
    const branchSpacing = 14;
    const mainY = Math.max(28, branchSpacing * branches.length + 22);
    const totalH = mainY + 44;
    const totalW = labelW + width + padX * 2;

    function xPos(ms) { return labelW + padX + (ms - minMs) / range * width; }

    // sorted = branches in the order we'll draw them (oldest first → highest Y).
    const sorted = branches;

    const colorByState = {
        'ahead':            '#16a34a',
        'diverged':         '#d97706',
        'merged-and-stale': '#9ca3af',
        'identical':        '#9ca3af',
        'unknown':          '#9ca3af'
    };

    const mainStaleDays = mainBranch && mainBranch.lastCommit
        ? Math.round((todayMs - new Date(mainBranch.lastCommit).getTime()) / 86400000)
        : null;
    const mainHeader = mainStaleDays != null
        ? (mainStaleDays > STALE_DAYS
            ? '<span style="color:var(--danger);font-weight:600">⚠ main idle ' + mainStaleDays + 'd</span>'
            : '<span style="color:var(--gray-500)">main updated ' + mainStaleDays + 'd ago</span>')
        : '<span style="color:var(--gray-400)">no main data</span>';

    let svg = '<svg class="gt2-bg-svg" width="' + totalW + '" height="' + totalH + '" xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision">';

    // Year ticks (very faint)
    const startYear = new Date(minMs).getFullYear();
    const endYear = new Date(maxMs).getFullYear();
    for (let y = startYear; y <= endYear; y++) {
        const ms = new Date(y, 0, 1).getTime();
        if (ms < minMs || ms > maxMs) continue;
        const x = xPos(ms);
        svg += '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + totalH + '" stroke="rgba(0,0,0,0.04)" stroke-width="1"/>';
        svg += '<text x="' + (x + 4) + '" y="11" fill="#cbd5e1" font-size="10">' + y + '</text>';
    }

    // Today line
    const todayX = xPos(todayMs);
    svg += '<line x1="' + todayX + '" y1="0" x2="' + todayX + '" y2="' + totalH + '" stroke="#dc2626" stroke-width="1" stroke-dasharray="3,3" opacity="0.6"/>';

    // Main branch — solid up to its last commit, dashed afterwards.
    // The visual contrast makes "main is idle while feature branches keep
    // committing" jump out: feature dots will appear to the right of main's
    // last-commit dot, on top of the dashed/idle segment.
    const mainStart = labelW + padX;
    const mainEnd = labelW + padX + width;
    const mainColor = mainStaleDays != null && mainStaleDays > STALE_DAYS ? '#dc2626' : '#1e3a8a';
    const mainLastMs = mainBranch && mainBranch.lastCommit ? new Date(mainBranch.lastCommit).getTime() : null;
    if (mainLastMs) {
        const mainBreakX = xPos(mainLastMs);
        // Active segment: divergedAt-of-chart → mainLastCommit (solid)
        svg += '<line x1="' + mainStart + '" y1="' + mainY + '" x2="' + mainBreakX + '" y2="' + mainY + '" stroke="' + mainColor + '" stroke-width="2" stroke-linecap="round"/>';
        // Idle segment: mainLastCommit → today (dashed, faded)
        svg += '<line x1="' + mainBreakX + '" y1="' + mainY + '" x2="' + mainEnd + '" y2="' + mainY + '" stroke="' + mainColor + '" stroke-width="2" stroke-linecap="round" stroke-dasharray="5,4" opacity="0.55"/>';
    } else {
        // No main data — single solid line (fallback)
        svg += '<line x1="' + mainStart + '" y1="' + mainY + '" x2="' + mainEnd + '" y2="' + mainY + '" stroke="' + mainColor + '" stroke-width="2" stroke-linecap="round"/>';
    }
    svg += '<text x="' + (labelW + padX - 8) + '" y="' + (mainY + 4) + '" fill="' + mainColor + '" font-size="11" font-weight="600" text-anchor="end">' + repo.defaultBranch + '</text>';

    // Branches — cubic Bezier (smooth S-curve) on entry and exit. The
    // transition length should be ~3-4× the row spacing so the curve reads
    // as a gentle arc rather than a sharp 90° turn.
    const curveDx = Math.max(40, branchSpacing * 4);
    sorted.forEach((b, i) => {
        const branchY = mainY - branchSpacing * (i + 1);
        const color = colorByState[b.state] || '#9ca3af';
        const isActive = b.state === 'ahead' || b.state === 'diverged';
        const startMs = b.divergedAt ? new Date(b.divergedAt).getTime() : new Date(b.lastCommit).getTime();
        const lastCommitMs = b.lastCommit ? new Date(b.lastCommit).getTime() : null;
        // Visual end of the line = the actual latest commit, not "today". For
        // merged-and-stale we then curve back to main at that point.
        const endMs = lastCommitMs || todayMs;
        const xs = xPos(startMs);
        const xe = xPos(endMs);
        // Allow xe === xs — that's a point-in-time branch (divergedAt ===
        // lastCommit, common for merged-and-stale). The short-span fallback
        // below renders it as a vertical tick.
        if (xe < xs) return;

        const branchUrl = 'https://github.com/' + repo.repo + '/tree/' + encodeURIComponent(b.name);
        const lastDate = b.lastCommit ? b.lastCommit.substring(0, 10) : '';
        const ageDays = b.lastCommit ? Math.round((todayMs - new Date(b.lastCommit).getTime()) / 86400000) : null;
        const opacity = isActive ? 0.95 : 0.55;
        const dasharray = b.state === 'merged-and-stale' ? '4,3' : '';
        const ageLabel = ageDays != null ? ' · ' + ageDays + 'd' : '';

        // Short-span fallback: when the on-screen span is too small for a full
        // S-curve to fit (e.g. a branch that lived a few days on a multi-year
        // chart), the cubic Bezier collapses into ~3px and reads as a
        // disconnected vertical needle. Render a clean vertical tick + dot
        // instead so the branch still shows up but doesn't visually detach
        // from main. Open circle on main keeps the "diverged here" anchor.
        const pixelSpan = xe - xs;
        const minPixelSpanForCurve = curveDx * 2 + 6;
        if (pixelSpan < minPixelSpanForCurve) {
            const compactTooltip = repo.repo + '#' + b.name
                + '\n' + b.state + ' · ahead ' + (b.ahead || 0) + ' · behind ' + (b.behind || 0)
                + '\nLast commit: ' + lastDate + (ageDays != null ? ' (' + ageDays + 'd ago)' : '')
                + '\n(span too short for arc — shown as tick)'
                + '\nClick to open on GitHub';
            svg += '<g class="gt2-bg-branch" data-href="' + branchUrl + '" style="cursor:pointer">';
            svg += '<title>' + compactTooltip + '</title>';
            svg += '<line x1="' + xs + '" y1="' + mainY + '" x2="' + xs + '" y2="' + branchY + '" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" opacity="' + opacity + '"' + (dasharray ? ' stroke-dasharray="' + dasharray + '"' : '') + '/>';
            svg += '<circle cx="' + xs + '" cy="' + mainY + '" r="2.5" fill="white" stroke="' + color + '" stroke-width="1.5"/>';
            if (lastCommitMs) {
                svg += '<circle cx="' + xs + '" cy="' + branchY + '" r="3.5" fill="' + color + '" opacity="' + opacity + '"/>';
            }
            svg += '<text x="' + (labelW + padX - 8) + '" y="' + (branchY + 3.5) + '" fill="' + color + '" font-size="10" font-weight="500" text-anchor="end" opacity="' + opacity + '">' + b.name + ageLabel + '</text>';
            svg += '</g>';
            return;
        }

        // Path is split into TWO segments so the merge curve is always solid,
        // even when the branch body is dashed (merged-and-stale):
        //   bodyD  = divergence curve up + horizontal run along the branch
        //   mergeD = curve back down to main (only for merged branches)
        // Cubic Bezier: control points share the horizontal axis with their
        // anchor (cp1 at start.y, cp2 at end.y) → smooth horizontal-to-horizontal
        // S-curve.
        const dx = Math.min(curveDx, (xe - xs) / 2);
        const bodyEndX = xe - (isActive ? 0 : dx);
        // Cubic Bezier with control points horizontally aligned to BOTH
        // endpoints — gives a perfect S-curve with horizontal tangents on
        // each side, no kinks.
        const half = dx / 2;
        let bodyD = 'M ' + xs + ' ' + mainY;
        bodyD += ' C ' + (xs + half) + ' ' + mainY + ', ' + (xs + half) + ' ' + branchY + ', ' + (xs + dx) + ' ' + branchY;
        bodyD += ' L ' + bodyEndX + ' ' + branchY;

        const mergeD = !isActive
            ? 'M ' + bodyEndX + ' ' + branchY + ' C ' + (xe - half) + ' ' + branchY + ', ' + (xe - half) + ' ' + mainY + ', ' + xe + ' ' + mainY
            : null;

        const tooltip = repo.repo + '#' + b.name + '\n' + b.state + ' · ahead ' + (b.ahead || 0) + ' · behind ' + (b.behind || 0) + '\nLast commit: ' + lastDate + (ageDays != null ? ' (' + ageDays + 'd ago)' : '') + (mergeD ? '\nMerged into ' + repo.defaultBranch : '') + '\nClick to open on GitHub';

        svg += '<g class="gt2-bg-branch" data-href="' + branchUrl + '" style="cursor:pointer">';
        svg += '<title>' + tooltip + '</title>';
        // Generous hit area covering the whole path
        svg += '<path d="' + bodyD + (mergeD ? ' ' + mergeD : '') + '" stroke="transparent" stroke-width="12" fill="none"/>';
        // Body of the branch (may be dashed)
        svg += '<path d="' + bodyD + '" stroke="' + color + '" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="' + opacity + '"' + (dasharray ? ' stroke-dasharray="' + dasharray + '"' : '') + '/>';
        // Merge curve back to main — always SOLID, slightly thicker than the
        // branch body, full opacity. The deliberate emphasis makes the "this
        // branch converges back to main here" arc unambiguous, even when the
        // branch body itself is dashed (merged-and-stale).
        if (mergeD) {
            svg += '<path d="' + mergeD + '" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.95"/>';
        }
        // Divergence marker on main (open circle)
        svg += '<circle cx="' + xs + '" cy="' + mainY + '" r="2.5" fill="white" stroke="' + color + '" stroke-width="1.5"/>';
        // Latest-commit marker — filled dot at the actual lastCommit position
        // on the BRANCH line. For active branches the path ends here; for
        // merged branches the merge curve starts here and arcs back to main.
        // Position must match the path's body end (bodyEndX, branchY).
        if (lastCommitMs) {
            svg += '<circle cx="' + bodyEndX + '" cy="' + branchY + '" r="3.5" fill="' + color + '" opacity="' + opacity + '"/>';
        }
        // Merge-into-main marker — small downward-pointing triangle on main
        // where the merge curve lands. Only drawn for merged branches.
        // Combined with the always-solid merge curve above, this makes
        // "X merged into main here" unambiguous at a glance.
        if (!isActive && lastCommitMs) {
            const tw = 4;
            svg += '<polygon points="' + (xe - tw) + ',' + (mainY - tw - 1) + ' ' + (xe + tw) + ',' + (mainY - tw - 1) + ' ' + xe + ',' + (mainY + 1) + '" fill="' + color + '" opacity="0.9"><title>' + b.name + ' merged into ' + repo.defaultBranch + '</title></polygon>';
        }
        // Label in left gutter (ageLabel declared at top of forEach)
        svg += '<text x="' + (labelW + padX - 8) + '" y="' + (branchY + 3.5) + '" fill="' + color + '" font-size="10" font-weight="500" text-anchor="end" opacity="' + opacity + '">' + b.name + ageLabel + '</text>';
        svg += '</g>';
    });

    // Latest-commit marker on main itself
    if (mainBranch && mainBranch.lastCommit) {
        const mainXe = xPos(new Date(mainBranch.lastCommit).getTime());
        svg += '<circle cx="' + mainXe + '" cy="' + mainY + '" r="3.5" fill="' + mainColor + '"><title>' + repo.defaultBranch + ' last commit: ' + mainBranch.lastCommit.substring(0, 10) + '</title></circle>';
    }

    // Branch→branch merge arcs were dropped: in tight time windows they piled
    // on top of the merge-into-main triangles and created visual spaghetti
    // for little semantic gain in an operational view. The triangle marker
    // on main + branch body curve already conveys "this branch merged here".

    svg += '</svg>';

    // Per-repo summary counts for the header
    const activeCount = branches.filter(b => b.state === 'ahead' || b.state === 'diverged').length;
    const staleCount = branches.filter(b => b.state === 'merged-and-stale').length;
    const summaryBits = [];
    summaryBits.push(branches.length + ' branch' + (branches.length === 1 ? '' : 'es'));
    if (activeCount) summaryBits.push('<span style="color:#16a34a;font-weight:600">' + activeCount + ' active</span>');
    if (staleCount) summaryBits.push('<span style="color:var(--gray-500)">' + staleCount + ' stale</span>');
    summaryBits.push(mainHeader);

    // Collapsable card; default state matches `gt2-bg-collapsed` global so
    // a single toggle can flip every card on the page.
    const collapsed = window._branchesCollapsed === true;
    const safeId = 'bg-' + repo.repo.replace(/[^a-z0-9]/gi, '-');

    return '<div class="card gt2-bg-card" data-repo="' + repo.repo + '" style="margin-bottom:0.75rem">'
        + '<div class="card-header gt2-bg-header" onclick="toggleBranchCard(\'' + safeId + '\')" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;cursor:pointer">'
        +   '<div style="display:flex;align-items:center;gap:0.5rem">'
        +     '<svg id="' + safeId + '-chev" class="gt2-bg-chevron' + (collapsed ? '' : ' open') + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>'
        +     '<a href="https://github.com/' + repo.repo + '" target="_blank" onclick="event.stopPropagation()" style="color:var(--primary);text-decoration:none;font-weight:600">' + repo.repo + ' ↗</a>'
        +     (repo.description ? '<span style="color:var(--gray-500);font-size:0.8125rem">' + repo.description + '</span>' : '')
        +   '</div>'
        +   '<div style="font-size:0.8125rem;color:var(--gray-700)">' + summaryBits.join(' · ') + '</div>'
        + '</div>'
        + '<div id="' + safeId + '-body" class="card-body gt2-bg-body" style="padding:0.5rem;overflow-x:auto;' + (collapsed ? 'display:none' : '') + '">'
        +   '<div id="' + safeId + '-svg-fallback">' + svg + '</div>'
        + '</div></div>';
}

// After the DOM has the cards in place, render gitgraph.js into each repo's
// dedicated container. Reads the same per-branch data we use for the SVG
// fallback. Note: gitgraph.js is commit-sequential so the X axis is no longer
// proportional to time — it's just commit order. Trade-off accepted in
// exchange for clean curves and zero kinks.
function renderGitgraphsForBranchCards() {
    const lib = window.gitgraphLib;
    if (!lib) return;
    const { createGitgraph, templateExtend, TemplateName, Orientation } = lib;

    const cards = document.querySelectorAll('.gt2-bg-card[data-repo]');
    cards.forEach(card => {
        const repoFullName = card.getAttribute('data-repo');
        const repoEntry = (data.repos || []).find(r => r.repo === repoFullName);
        if (!repoEntry) return;
        const safeId = 'bg-' + repoFullName.replace(/[^a-z0-9]/gi, '-');
        const container = card.querySelector('#' + safeId + '-gitgraph');
        const fallback = card.querySelector('#' + safeId + '-svg-fallback');
        if (!container) return;

        // Filter the same way the SVG fallback does
        const defaultName = repoEntry.defaultBranch;
        const branches = (repoEntry.branches || []).filter(b => {
            if (b.name === defaultName) return false;
            if (b.state === 'identical') return false;
            if (!showStaleBranches && b.state === 'merged-and-stale') return false;
            const start = b.divergedAt ? new Date(b.divergedAt).getTime() : (b.lastCommit ? new Date(b.lastCommit).getTime() : null);
            const end = b.lastCommit ? new Date(b.lastCommit).getTime() : null;
            if (start == null || end == null || end <= start || end - start < 86400000) return false;
            return true;
        });

        if (branches.length === 0) {
            container.style.display = 'none';
            return;
        }
        // Hide the SVG fallback once gitgraph has data to render
        if (fallback) fallback.style.display = 'none';
        container.innerHTML = '';

        // Build a chronological event list, then replay through gitgraph.
        const mainBranchData = (repoEntry.branches || []).find(b => b.name === defaultName);
        const events = [];

        // Anchor: a synthetic earliest main commit just before the first divergence
        const firstDivergeMs = Math.min(
            ...branches.map(b => new Date(b.divergedAt || b.lastCommit).getTime())
        );
        events.push({ kind: 'mainCommit', date: firstDivergeMs - 1, label: 'init' });

        // Branch divergences + branch's last-commit dot
        for (const b of branches) {
            const divergeMs = b.divergedAt ? new Date(b.divergedAt).getTime() : new Date(b.lastCommit).getTime();
            events.push({ kind: 'branchOff', date: divergeMs, name: b.name, state: b.state });
            if (b.lastCommit) {
                events.push({ kind: 'branchCommit', date: new Date(b.lastCommit).getTime(), name: b.name });
            }
            // Merge curve back to main if merged-and-stale
            if (b.state === 'merged-and-stale' && b.lastCommit) {
                events.push({ kind: 'mergeIntoMain', date: new Date(b.lastCommit).getTime() + 1, source: b.name });
            }
        }

        // Cross-branch merges (deduped by source→target pair, latest only)
        const latestPair = {};
        const allWith = [...branches, mainBranchData].filter(Boolean);
        for (const target of allWith) {
            for (const m of (target.recentMerges || [])) {
                if (!m.source || !m.date || m.source === target.name) continue;
                const sourceExists = (target === mainBranchData) || branches.some(b => b.name === m.source);
                if (!sourceExists) continue;
                const ms = new Date(m.date).getTime();
                const key = m.source + '>>' + target.name;
                if (!latestPair[key] || latestPair[key].date < ms) {
                    latestPair[key] = { source: m.source, target: target.name, date: ms };
                }
            }
        }
        for (const m of Object.values(latestPair)) {
            const targetIsMain = m.target === defaultName;
            events.push({
                kind: targetIsMain ? 'mergeIntoMain' : 'mergeBetweenBranches',
                date: m.date, source: m.source, target: m.target
            });
        }

        // Main's own last commit, just to advance main
        if (mainBranchData && mainBranchData.lastCommit) {
            events.push({ kind: 'mainCommit', date: new Date(mainBranchData.lastCommit).getTime(), label: 'main' });
        }

        // Sort by date ascending; stable secondary by event kind so branchOff
        // comes before any commits/merges that depend on it.
        const order = { mainCommit: 0, branchOff: 1, branchCommit: 2, mergeBetweenBranches: 3, mergeIntoMain: 4 };
        events.sort((a, b) => a.date - b.date || (order[a.kind] - order[b.kind]));

        // Render with gitgraph
        // Each branch needs a UNIQUE color so my post-render matcher can find
        // its line in the SVG. (gitgraph.js doesn't expose data attributes per
        // branch, so colour is the only stable identifier.) State is encoded
        // in the label text/decoration instead.
        const branchPalette = [
            '#16a34a', '#d97706', '#7c3aed', '#0d9488', '#dc2626',
            '#0284c7', '#9333ea', '#0891b2', '#65a30d', '#c026d3',
            '#059669', '#ea580c', '#4f46e5', '#a16207', '#be123c',
            '#15803d', '#b45309', '#5b21b6', '#0e7490', '#9f1239'
        ];
        const colorForBranch = (index) => branchPalette[index % branchPalette.length];
        // Decoration to add to the label text, based on branch state
        const stateDecorator = {
            'ahead':            '',
            'diverged':         ' ⚠',
            'merged-and-stale': ' ✓',
            'unknown':          ' ?'
        };
        const template = templateExtend(TemplateName.Metro, {
            colors: ['#1e3a8a', '#16a34a', '#d97706', '#9ca3af', '#7c3aed', '#0d9488', '#dc2626'],
            branch: {
                lineWidth: 2,
                spacing: 18,
                // Branch labels disabled because in horizontal orientation
                // gitgraph.js positions them in the next row down — they end
                // up belonging visually to the wrong branch. We render an
                // explicit colour legend underneath the graph instead.
                label: { display: false }
            },
            commit: {
                spacing: 26,
                dot: { size: 4 },
                message: {
                    display: true,
                    displayAuthor: false,
                    displayHash: false,
                    font: 'normal 9px -apple-system, Segoe UI, sans-serif',
                    color: '#6b7280'
                }
            }
        });
        const graph = createGitgraph(container, {
            template,
            orientation: Orientation.Horizontal,
        });
        const main = graph.branch({ name: defaultName, style: { color: '#1e3a8a' } });
        const branchRefs = { [defaultName]: main };
        // Per-branch metadata for the overlay matcher
        const branchMeta = { [defaultName]: { color: '#1e3a8a', state: '' } };

        const dateLabel = (ms) => new Date(ms).toISOString().substring(0, 10); // YYYY-MM-DD

        let branchIndex = 0;
        for (const e of events) {
            try {
                if (e.kind === 'mainCommit') {
                    main.commit({ subject: dateLabel(e.date), hash: '' });
                } else if (e.kind === 'branchOff') {
                    const color = colorForBranch(branchIndex++);
                    branchRefs[e.name] = main.branch({
                        name: e.name,
                        style: { color }
                    });
                    branchMeta[e.name] = { color, state: e.state };
                } else if (e.kind === 'branchCommit') {
                    if (branchRefs[e.name]) branchRefs[e.name].commit({ subject: dateLabel(e.date), hash: '' });
                } else if (e.kind === 'mergeIntoMain') {
                    if (branchRefs[e.source]) main.merge({ branch: branchRefs[e.source], commitOptions: { subject: dateLabel(e.date), hash: '' } });
                } else if (e.kind === 'mergeBetweenBranches') {
                    if (branchRefs[e.source] && branchRefs[e.target]) {
                        branchRefs[e.target].merge({ branch: branchRefs[e.source], commitOptions: { subject: dateLabel(e.date), hash: '' } });
                    }
                }
            } catch (err) {
                // gitgraph throws if a branch reference is missing; swallow and continue
            }
        }

        // After gitgraph renders, overlay branch-name labels matched by their
        // unique colours. Now that each branch has its own colour, the matcher
        // can identify them 1-to-1.
        overlayBranchLabelsByMeta(container, branchMeta, stateDecorator);
    });
}

function overlayBranchLabelsByMeta(container, branchMeta, stateDecorator) {
    setTimeout(() => doOverlayByMeta(container, branchMeta, stateDecorator), 0);
}

function doOverlayByMeta(container, branchMeta, stateDecorator) {
    const svg = container.querySelector('svg');
    if (!svg) {
        console.warn('[branches] overlay: no svg found in', container);
        return;
    }
    // Avoid double-rendering on re-runs
    svg.querySelectorAll('text.gt2-bg-overlay-label').forEach(el => el.remove());

    // Build a 1-to-1 (color → branch) list from the meta we collected during
    // event replay. Every branch has a unique colour now. Normalize the
    // colour so we match SVG output regardless of hex/rgb representation.
    const norm = (raw) => {
        if (!raw) return raw;
        let s = String(raw).trim().toLowerCase();
        const m = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
        if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
        return s;
    };
    const wanted = Object.entries(branchMeta).map(([name, meta]) => ({
        color: norm(meta.color),
        name,
        state: meta.state
    }));

    // ── Diagnostic dump (one-time per render) ─────────────────────────
    console.group('[branches] overlay debug for ' + (container.id || container.parentElement?.parentElement?.dataset?.repo || '?'));
    console.log('expected (color → branch):', wanted);
    const allCircles = svg.querySelectorAll('circle');
    const allPaths = svg.querySelectorAll('path');
    console.log('SVG counts:', { circles: allCircles.length, paths: allPaths.length });
    const sampleColors = new Set();
    allCircles.forEach(c => {
        const fill = c.getAttribute('fill') || '';
        const stroke = c.getAttribute('stroke') || '';
        const style = c.getAttribute('style') || '';
        if (fill && fill !== 'none') sampleColors.add('fill=' + fill);
        if (stroke && stroke !== 'none') sampleColors.add('stroke=' + stroke);
        if (style) sampleColors.add('style=' + style);
    });
    allPaths.forEach(p => {
        const stroke = p.getAttribute('stroke') || '';
        const style = p.getAttribute('style') || '';
        if (stroke && stroke !== 'none') sampleColors.add('path-stroke=' + stroke);
        if (style) sampleColors.add('path-style=' + style.substring(0, 80));
    });
    console.log('observed colors in SVG:', [...sampleColors]);

    // Walk every drawn element with a stroke or fill color and pick out the
    // RIGHTMOST coordinate per color (where the branch ends — most space for
    // the label). We also check inline `style="..."` for stroke/fill since
    // gitgraph.js sometimes sets colors via the style attribute.
    const colorToPos = {}; // color (lowercase) → { x, y }
    const collect = (color, x, y) => {
        if (color == null) return;
        const k = String(color).toLowerCase().trim();
        if (!k) return;
        if (!isFinite(x) || !isFinite(y)) return;
        const prev = colorToPos[k];
        if (!prev || x > prev.x) colorToPos[k] = { x, y };
    };
    const colorFromStyle = (style, prop) => {
        const m = style && new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)').exec(style);
        return m ? m[1].trim() : '';
    };
    // gitgraph.js renders each branch as a long, near-horizontal path with a
    // stroke color matching the branch's color. Merge curves and commit dots
    // also use the same color but have very different shapes (curves with
    // significant Y range, or tiny dots). To find the BRANCH LINE for each
    // color we filter paths to those that are long-and-flat.
    //
    // We also need transforms: gitgraph applies translate(...) to ancestor
    // <g> elements, so element.getBBox() gives local coords. Compose the CTM
    // up to the SVG root to read true SVG-space coordinates.
    const transformedXY = (el, localX, localY) => {
        const ctm = el.getCTM ? el.getCTM() : null;
        if (!ctm) return { x: localX, y: localY };
        return {
            x: ctm.a * localX + ctm.c * localY + ctm.e,
            y: ctm.b * localX + ctm.d * localY + ctm.f
        };
    };
    // Normalize any color string (hex, rgb(...), rgba(...), 3-digit hex) to a
    // canonical lowercase 6-digit hex so we can match across format differences.
    const normalizeColor = (raw) => {
        if (!raw) return null;
        let s = String(raw).trim().toLowerCase();
        if (s === 'none' || s === 'transparent') return null;
        // rgb(r, g, b) or rgba(r, g, b, a)
        let m = s.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (m) {
            const hex = (n) => Number(n).toString(16).padStart(2, '0');
            return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
        }
        // 3-digit hex #abc → #aabbcc
        m = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
        if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
        // Already 6-digit hex
        if (/^#[0-9a-f]{6}$/.test(s)) return s;
        return s;
    };

    // Walk every commit dot (circle). For each colour we COLLECT ALL POSITIONS,
    // then pick the most frequent Y as the branch's true row — gitgraph paints
    // merge-commit dots with the source branch's colour but at the *target*
    // branch's Y, which would otherwise pull the label to the wrong row.
    const dotsByColor = {}; // color → [{x, y}]
    const colorFor = (raw) => {
        const k = normalizeColor(raw);
        return k || null;
    };
    allCircles.forEach(c => {
        const fill = c.getAttribute('fill') || colorFromStyle(c.getAttribute('style'), 'fill');
        const stroke = c.getAttribute('stroke') || colorFromStyle(c.getAttribute('style'), 'stroke');
        const color = colorFor((fill && fill !== 'none') ? fill : stroke);
        if (!color) return;
        const cx = parseFloat(c.getAttribute('cx')) || 0;
        const cy = parseFloat(c.getAttribute('cy')) || 0;
        const t = transformedXY(c, cx, cy);
        if (!isFinite(t.x) || !isFinite(t.y)) return;
        (dotsByColor[color] = dotsByColor[color] || []).push(t);
    });

    // Resolve each colour to a single (x, y): the most-common Y (mode), then
    // the rightmost X *at that Y* (rounded to nearest pixel for grouping).
    for (const [color, dots] of Object.entries(dotsByColor)) {
        const yCounts = {};
        for (const d of dots) {
            const yKey = Math.round(d.y);
            yCounts[yKey] = (yCounts[yKey] || 0) + 1;
        }
        let bestY = null, bestCount = 0;
        for (const [y, count] of Object.entries(yCounts)) {
            if (count > bestCount || (count === bestCount && Number(y) < Number(bestY))) {
                bestCount = count; bestY = Number(y);
            }
        }
        if (bestY == null) continue;
        // Among dots at the chosen Y, pick the rightmost X
        let bestX = -Infinity;
        for (const d of dots) {
            if (Math.round(d.y) === bestY && d.x > bestX) bestX = d.x;
        }
        if (isFinite(bestX)) colorToPos[color] = { x: bestX, y: bestY };
    }

    // Path fallback: only used when a colour produced ZERO dot detections at
    // all (rare — happens when a branch has only a curve, no commit dot).
    allPaths.forEach(p => {
        const stroke = colorFor(p.getAttribute('stroke') || colorFromStyle(p.getAttribute('style'), 'stroke'));
        if (!stroke || colorToPos[stroke]) return;
        try {
            const bbox = p.getBBox();
            const t = transformedXY(p, bbox.x + bbox.width, bbox.y + bbox.height / 2);
            if (isFinite(t.x) && isFinite(t.y)) colorToPos[stroke] = { x: t.x, y: t.y };
        } catch { /* getBBox can throw on detached nodes */ }
    });
    console.log('colorToPos result:', colorToPos);
    console.groupEnd();

    // Compute the maximum X across the SVG so we know how far we can place
    // labels. We'll also expand the SVG's width to fit the labels comfortably.
    let maxX = 0;
    for (const pos of Object.values(colorToPos)) maxX = Math.max(maxX, pos.x);

    const ns = 'http://www.w3.org/2000/svg';
    const labelGap = 10;
    const labelWidthEstimate = 140; // rough max needed for a long branch name
    let added = 0;
    // Build a Y → branch-name index so hover tooltips can identify which line
    // the cursor is on.
    const branchAtY = {};
    for (const w of wanted) {
        const pos = colorToPos[w.color];
        if (!pos) continue;
        branchAtY[Math.round(pos.y)] = w.name + (stateDecorator && stateDecorator[w.state] || '');
    }
    for (const w of wanted) {
        const pos = colorToPos[w.color];
        if (!pos) continue;
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('class', 'gt2-bg-overlay-label');
        text.setAttribute('x', String(pos.x + labelGap));
        text.setAttribute('y', String(pos.y + 3));
        text.setAttribute('fill', w.color);
        text.setAttribute('font-size', '10');
        text.setAttribute('font-weight', '600');
        text.setAttribute('text-anchor', 'start');
        text.setAttribute('pointer-events', 'none');
        const decoration = (stateDecorator && stateDecorator[w.state]) || '';
        text.textContent = w.name + decoration;
        svg.appendChild(text);
        added++;
    }
    // Add SVG <title> tooltips on every dot/path so hovering shows the branch.
    // <title> is native browser tooltip — no extra layout, no extra styling.
    const setTitle = (el, name) => {
        if (!name) return;
        // Remove any existing title to avoid stacking
        const existing = el.querySelector(':scope > title');
        if (existing) existing.remove();
        const title = document.createElementNS(ns, 'title');
        title.textContent = name;
        el.insertBefore(title, el.firstChild);
    };
    allCircles.forEach(c => {
        const fill = c.getAttribute('fill') || colorFromStyle(c.getAttribute('style'), 'fill');
        const stroke = c.getAttribute('stroke') || colorFromStyle(c.getAttribute('style'), 'stroke');
        const color = normalizeColor((fill && fill !== 'none') ? fill : stroke);
        if (!color) return;
        // Resolve the branch name by colour first; if the dot is at a different
        // Y than the colour's branch row, prefer the row-based lookup (merge
        // dots on a different branch's row).
        const cx = parseFloat(c.getAttribute('cx')) || 0;
        const cy = parseFloat(c.getAttribute('cy')) || 0;
        const t = transformedXY(c, cx, cy);
        const yKey = Math.round(t.y);
        const fromColor = wanted.find(w => w.color === color);
        const colorPos = fromColor && colorToPos[fromColor.color];
        const isOnOwnRow = colorPos && Math.round(colorPos.y) === yKey;
        const name = isOnOwnRow && fromColor ? fromColor.name + (stateDecorator[fromColor.state] || '') : (branchAtY[yKey] || (fromColor && fromColor.name));
        setTitle(c, name);
    });
    allPaths.forEach(p => {
        const stroke = normalizeColor(p.getAttribute('stroke') || colorFromStyle(p.getAttribute('style'), 'stroke'));
        if (!stroke) return;
        const fromColor = wanted.find(w => w.color === stroke);
        if (fromColor) setTitle(p, fromColor.name + (stateDecorator[fromColor.state] || ''));
    });

    // Stretch the SVG (and its viewBox if present) to make room for the labels.
    const currentWidth = parseFloat(svg.getAttribute('width')) || svg.getBoundingClientRect().width || 600;
    const neededWidth = Math.max(currentWidth, maxX + labelGap + labelWidthEstimate);
    svg.setAttribute('width', String(neededWidth));
    const vb = svg.getAttribute('viewBox');
    if (vb) {
        const parts = vb.split(/\s+/).map(parseFloat);
        if (parts.length === 4) {
            const newViewWidth = Math.max(parts[2], maxX + labelGap + labelWidthEstimate - parts[0]);
            svg.setAttribute('viewBox', `${parts[0]} ${parts[1]} ${newViewWidth} ${parts[3]}`);
        }
    }
    console.log('[branches] overlay: added', added, 'of', wanted.length, 'labels');
}

// Toggle a single repo card's branch graph
function toggleBranchCard(safeId) {
    const body = document.getElementById(safeId + '-body');
    const chev = document.getElementById(safeId + '-chev');
    if (!body) return;
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    if (chev) chev.classList.toggle('open', !isOpen);
}

// Expand / collapse every repo card at once
function toggleAllBranchCards(open) {
    window._branchesCollapsed = !open;
    document.querySelectorAll('.gt2-bg-body').forEach(el => { el.style.display = open ? 'block' : 'none'; });
    document.querySelectorAll('.gt2-bg-chevron').forEach(el => { el.classList.toggle('open', !!open); });
}

function toggleShowStaleBranches(el) {
    showStaleBranches = !!el.checked;
    renderBranches();
}
// Expose explicitly on window so the inline `onchange="..."` resolves it
// reliably across bundled environments.
window.toggleShowStaleBranches = toggleShowStaleBranches;
window.toggleAllBranchCards = toggleAllBranchCards;
window.toggleBranchCard = toggleBranchCard;

// ═══════════════════════════════════════════════════════════════════════════
// REFSETS — Belgian SNOMED reference sets imported from a TSV (authored by
// the terminology team) cross-referenced against FHIR ValueSets discovered
// during crawls. For each refset, lists the ValueSets that include it and
// the IG/package they live in (so you can tell "published" vs "CI" usage).
//
// SNOMED refsets are referenced from FHIR ValueSets by SCTID, typically:
//   compose.include[].filter[]: { property: 'constraint',  op: '=', value: '^<SCTID>' }
//                            or { property: 'concept',     op: 'in', value: '<SCTID>' }
//   The referenced SCTID may also appear inside ECL strings: ^<SCTID>, <<<SCTID>, etc.
//
// The crawler stores the raw `vsComposition` and concept lists in artifactMeta;
// we additionally scan each artifact's resource via `data.refsetUsages`
// (built from artifact metadata at render time) to find SCTID matches.
// ═══════════════════════════════════════════════════════════════════════════
function renderRefsets() {
    const container = document.getElementById('viewContent');
    const refsets = data.refsets || [];
    if (refsets.length === 0) {
        container.innerHTML = '<div class="card"><div class="card-body" style="color:var(--gray-400);padding:2rem;text-align:center">'
            + 'No refsets loaded. Place the TSV at <code>public/data/imports/Belgian_Refsets.tsv</code> and reload.'
            + '</div></div>';
        return;
    }

    // Build an index: SCTID → list of { artifact, package, status, location }
    const usagesBySctid = {};
    function pushUsage(sctid, usage) {
        (usagesBySctid[sctid] = usagesBySctid[sctid] || []).push(usage);
    }

    // Scan crawled valueset artifacts (attached to data.packages by main.js
    // after a crawl) for SCTID references. We look at any string field that
    // could contain ECL or filter values.
    const sctidRegex = /\b(\d{8,18})\b/g;
    for (const [pkgName, info] of Object.entries(data.packages || {})) {
        if (!info || !info.artifacts) continue;
        for (const art of info.artifacts) {
            if (art.type !== 'valueset' && art.type !== 'codesystem') continue;
            // Concatenate every searchable string we have for the artifact and
            // pull out 8-18 digit numbers (SNOMED concept ids range 6-18 digits;
            // 8 is a safe lower bound for refsets).
            const haystack = [art.url, art.name, art.title, art.id, JSON.stringify(art.vsComposition || ''), JSON.stringify(art.includes || ''), JSON.stringify(art.filters || '')].filter(Boolean).join(' ');
            let m;
            const seen = new Set();
            while ((m = sctidRegex.exec(haystack)) !== null) {
                if (seen.has(m[1])) continue;
                seen.add(m[1]);
                pushUsage(m[1], {
                    package: pkgName,
                    artifactId: art.id,
                    artifactName: art.name || art.title || art.id,
                    type: art.type,
                    url: art.url,
                    // Distinguish published vs CI based on package source/url
                    status: classifyRefsetUsageStatus(pkgName, info, art)
                });
            }
        }
    }

    // ── Render ─────────────────────────────────────────────────────────
    const groupBy = {};
    for (const r of refsets) {
        (groupBy[r.purpose] = groupBy[r.purpose] || []).push(r);
    }

    const totalRefsets = refsets.length;
    const usedRefsets = refsets.filter(r => (usagesBySctid[r.sctid] || []).length > 0).length;
    const unusedRefsets = totalRefsets - usedRefsets;

    let html = '<div style="margin-bottom:1rem;font-size:0.875rem;color:var(--gray-600)">'
        + 'Belgian SNOMED reference sets imported from <code>public/data/imports/Belgian_Refsets.tsv</code>.'
        + ' For each refset, shows FHIR ValueSets that reference it (matched by SCTID across crawled artifacts).'
        + ' Re-issue: replace the TSV file and reload — no rebuild needed.'
        + '</div>'
        + '<div class="stats-row">'
        + '<div class="stat-card"><div class="stat-value">' + totalRefsets + '</div><div class="stat-label">Refsets</div></div>'
        + '<div class="stat-card" style="border-left:3px solid var(--success)"><div class="stat-value" style="color:var(--success)">' + usedRefsets + '</div><div class="stat-label">Referenced by ≥1 ValueSet</div></div>'
        + '<div class="stat-card" style="border-left:3px solid var(--gray-400)"><div class="stat-value" style="color:var(--gray-500)">' + unusedRefsets + '</div><div class="stat-label">Not referenced</div></div>'
        + '</div>'
        + '<div style="display:flex;gap:0.5rem;margin-bottom:1rem">'
        +   '<button class="btn btn-sm btn-ghost" onclick="downloadRefsetReport(\'csv\')">Download CSV</button>'
        +   '<button class="btn btn-sm btn-ghost" onclick="downloadRefsetReport(\'json\')">Download JSON</button>'
        + '</div>';

    for (const purpose of Object.keys(groupBy).sort()) {
        const rows = groupBy[purpose];
        html += '<div class="card"><div class="card-header">' + purpose + ' <span style="color:var(--gray-400);font-weight:400;font-size:0.8125rem">(' + rows.length + ')</span></div>';
        html += '<div class="card-body" style="padding:0"><table>'
            + '<thead><tr>'
            + '<th>Refset</th><th style="width:11rem">SCTID</th><th>Used in ValueSets</th>'
            + '</tr></thead><tbody>';
        for (const r of rows) {
            const usages = usagesBySctid[r.sctid] || [];
            html += '<tr>'
                + '<td>' + escapeHtml(r.subset) + '</td>'
                + '<td><code style="font-size:0.8125rem">' + r.sctid + '</code></td>'
                + '<td>'
                + (usages.length === 0
                    ? '<span style="color:var(--gray-400);font-size:0.8125rem">—</span>'
                    : '<ul style="list-style:none;padding-left:0;margin:0">'
                        + usages.map(u =>
                            '<li style="padding:1px 0;font-size:0.8125rem">'
                            + statusBadgeForRefsetUsage(u.status)
                            + ' <strong>' + escapeHtml(u.artifactName) + '</strong>'
                            + ' <span style="color:var(--gray-500)">(' + u.package + ')</span>'
                            + (u.url ? ' <a href="' + u.url + '" target="_blank" style="color:var(--primary);font-size:0.75rem">↗</a>' : '')
                            + '</li>')
                          .join('')
                        + '</ul>')
                + '</td>'
                + '</tr>';
        }
        html += '</tbody></table></div></div>';
    }

    container.innerHTML = html;

    // Cache for the download buttons
    window._refsetReport = { generatedAt: new Date().toISOString(), refsets, usagesBySctid };
}

// Decide if an artifact's containing package counts as "published" or "CI".
// Heuristic: a package with a publicationUrl AND a currentVersion is published;
// otherwise we treat it as CI (still in development, only on build.fhir.org).
function classifyRefsetUsageStatus(pkgName, pkgInfo, art) {
    if (pkgInfo && pkgInfo.currentVersion && pkgInfo.publicationUrl) return 'published';
    if (pkgInfo && pkgInfo.igUrl) return 'ci';
    return 'unknown';
}

function statusBadgeForRefsetUsage(status) {
    if (status === 'published') return '<span class="badge badge-published" style="font-size:0.625rem">published</span>';
    if (status === 'ci')        return '<span class="badge" style="font-size:0.625rem;background:var(--warning-light);color:#92400e">CI</span>';
    return '<span class="badge badge-planned" style="font-size:0.625rem">unknown</span>';
}

function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function downloadRefsetReport(format) {
    const r = window._refsetReport;
    if (!r) return;
    let content, filename, mime;
    if (format === 'json') {
        content = JSON.stringify(r, null, 2);
        filename = `belgian-refsets-report-${r.generatedAt.substring(0,10)}.json`;
        mime = 'application/json';
    } else {
        // CSV: one row per (refset, usage). Refsets with no usages still produce one row.
        const lines = ['Purpose,Subset,SCTID,Package,Artifact,Status,URL'];
        for (const rs of r.refsets) {
            const us = r.usagesBySctid[rs.sctid] || [];
            if (us.length === 0) {
                lines.push([rs.purpose, rs.subset, rs.sctid, '', '', '', ''].map(csvEscape).join(','));
            } else {
                for (const u of us) {
                    lines.push([rs.purpose, rs.subset, rs.sctid, u.package, u.artifactName, u.status, u.url || ''].map(csvEscape).join(','));
                }
            }
        }
        content = lines.join('\n');
        filename = `belgian-refsets-report-${r.generatedAt.substring(0,10)}.csv`;
        mime = 'text/csv';
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
}

function csvEscape(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
