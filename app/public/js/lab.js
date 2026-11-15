// API lab: the Microsoft Graph / SharePoint REST / Azure AI Search calls behind Sites.Selected — granting a site,
// checking what a user and the ingestion app can read, and confirming the result in the index. Each operation runs
// with one of three identities:
//   👤 you      — your delegated token, straight from the browser to Microsoft Graph (bounded by your own access);
//   🤖 app      — the ingestion app, app-only, on the server through its federated credential (fixed operations only);
//   🔎 search   — Azure AI Search through this app, with your token for ACL trimming.
import { tryToken } from './auth.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const ALL = ['alice', 'bob', 'carol', 'admin'];
const LABEL = { alice: 'Alice', bob: 'Bob', carol: 'Carol', admin: 'Admin' };

// Expected results per persona for the selected site. Keys: site key → persona → text.
const per = (m) => (site) => m[site] ?? m['*'] ?? null;

const OPS = [
  // ---------- 1 · Who am I ----------
  { id: 'me', group: 1, who: 'user', title: 'Who am I', method: 'GET', path: '/me?$select=id,displayName,userPrincipalName',
    perm: 'User.Read (delegated)',
    explain: 'Your object ID is what Azure AI Search matches against the <code>UserIds</code> field of every chunk.',
    expect: per({ '*': { alice: '200', bob: '200', carol: '200', admin: '200' } }) },
  { id: 'my-groups', group: 1, who: 'user', title: 'My groups (transitive)', method: 'GET',
    path: '/me/transitiveMemberOf/microsoft.graph.group?$select=id,displayName',
    perm: 'User.Read (delegated)',
    explain: 'Your Entra groups, including nested ones — Azure AI Search resolves the same list at query time and matches it against <code>GroupIds</code>. Compare the IDs with the stored ACL. <code>displayName</code> is <code>null</code> because users only grant this app <code>User.Read</code> here; names need <code>GroupMember.Read.All</code>.',
    expect: per({ '*': { alice: '200 — IDs incl. All staff + Quantum team (names null)', bob: '200 — IDs incl. All staff, not Quantum team', carol: '200 — IDs incl. All staff, not Quantum team', admin: '200 — IDs incl. Demo admins' } }) },
  { id: 'my-token', group: 1, who: 'local', title: 'Decode my Graph token', method: 'LOCAL', path: '(decoded in your browser, nothing is sent)',
    perm: '—',
    explain: 'The <code>scp</code> claim lists the delegated permissions this web app holds <b>for you</b>. Admins also get <code>Sites.FullControl.All</code> — it was consented for the deploying admin only.',
    expect: per({ '*': { alice: 'scp without Sites.FullControl.All', bob: 'scp without Sites.FullControl.All', carol: 'scp without Sites.FullControl.All', admin: 'scp includes Sites.FullControl.All' } }) },

  // ---------- 2 · Discover the site (as you) ----------
  { id: 'get-site', group: 2, who: 'user', site: true, title: 'Get the site', method: 'GET',
    path: '/sites/{host}:{sitePath}?$select=id,displayName,webUrl', perm: 'Sites.Read.All (delegated)',
    explain: 'Resolves the site URL to its Graph site ID (<code>host,siteCollectionId,webId</code>), needed by every other site call. As you, the call only succeeds if SharePoint lets you open the site.',
    capture: [{ var: 'siteId', one: (b) => b?.id && { id: b.id, label: b.displayName } }],
    expect: per({
      research: { alice: '200', bob: '200', carol: '200', admin: '200' },
      llmlab: { alice: '200', bob: '200', carol: '403 / 404 — no access to the subsite', admin: '200' },
      finance: { alice: '403 / 404', bob: '200 (Members)', carol: '403 / 404', admin: '200' },
      hr: { alice: '200 (All staff)', bob: '200 (All staff)', carol: '200 (All staff)', admin: '200' },
    }) },
  { id: 'list-drives', group: 2, who: 'user', site: true, title: 'List document libraries', method: 'GET',
    path: '/sites/{siteId}/drives?$select=id,name,webUrl', perm: 'Sites.Read.All (delegated)',
    explain: 'Each document library is a drive. <code>allSiteLibraries</code> on the data source indexes all of them (Research has <i>Documents</i> and <i>Archive</i>).',
    capture: [{ var: 'driveId', list: (b) => b?.value?.map((d) => ({ id: d.id, label: d.name })) }],
    expect: per({ research: { alice: 'Documents, Archive', bob: 'Documents, Archive', carol: 'Documents, Archive', admin: 'Documents, Archive' } }) },
  { id: 'list-root', group: 2, who: 'user', site: true, title: 'List folders (default library)', method: 'GET',
    path: '/sites/{siteId}/drive/root/children?$select=id,name,folder,webUrl,parentReference', perm: 'Files.Read.All / Sites.Read.All (delegated)',
    explain: 'SharePoint trims this list for you: folders with unique permissions that don\'t include you are simply missing. Pick a folder to inspect its permissions.',
    capture: [{ var: 'itemId', list: (b) => b?.value?.map((i) => ({ id: i.id, label: i.name, also: { driveId: i.parentReference?.driveId } })) }],
    expect: per({
      research: { alice: 'Public, Quantum', bob: 'Public', carol: 'Public, Bio', admin: 'Public, Quantum, Bio' },
      llmlab: { alice: 'Papers', bob: 'Papers, Drafts', carol: '— (no access)', admin: 'Papers, Drafts' },
      finance: { alice: '— (no access)', bob: 'Reports', carol: '— (no access)', admin: 'Reports' },
      hr: { alice: 'Confidential', bob: 'Confidential', carol: 'Confidential', admin: 'Confidential' },
    }) },
  { id: 'list-drive-root', group: 2, who: 'user', site: true, title: 'List folders (selected library)', method: 'GET',
    path: '/drives/{driveId}/root/children?$select=id,name,folder,webUrl,parentReference', perm: 'Files.Read.All (delegated)',
    explain: 'Same as above for the library picked in <i>List document libraries</i> (for example <i>Archive</i>).',
    capture: [{ var: 'itemId', list: (b) => b?.value?.map((i) => ({ id: i.id, label: i.name, also: { driveId: i.parentReference?.driveId } })) }],
    expect: per({ research: { alice: 'Archive: Notes', bob: 'Archive: Notes', carol: 'Archive: Notes', admin: 'Archive: Notes' } }) },
  { id: 'item-permissions', group: 2, who: 'user', site: true, title: 'Folder permissions', method: 'GET',
    path: '/drives/{driveId}/items/{itemId}/permissions', perm: 'Files.Read.All (delegated)',
    explain: '<code>grantedToV2</code> shows <code>siteGroup</code> (SharePoint group → <code>spg:</code> in the index), <code>group</code> (Entra group object ID) or <code>user</code>. <code>inheritedFrom</code> means the folder inherits the site\'s permissions.',
    expect: per({ '*': { alice: '200, empty list (readers can\'t list permissions)', bob: 'empty list — except Finance, where Bob has Edit', carol: '200, empty list', admin: 'full list' } }) },
  { id: 'subsites', group: 2, who: 'user', site: true, title: 'List subsites', method: 'GET',
    path: '/sites/{siteId}/sites?$select=id,displayName,webUrl', perm: 'Sites.Read.All (delegated)',
    explain: 'Subsites of the site. <code>includeSubsites=true</code> on the data source indexes them with the parent\'s grant.',
    expect: per({ research: { alice: 'LLM Lab', bob: 'LLM Lab', carol: '— (no access to LLM Lab)', admin: 'LLM Lab' }, '*': { alice: '—', bob: '—', carol: '—', admin: '—' } }) },
  { id: 'custom', group: 2, who: 'user', site: true, custom: true, title: 'Custom Graph request', method: 'GET',
    path: '/sites/{siteId}', perm: 'whatever this app holds for you (see “Decode my Graph token”)',
    explain: 'Any Microsoft Graph call with your delegated token — a small Graph Explorer. Placeholders such as <code>{siteId}</code> are filled from earlier results.',
    expect: () => null },

  // ---------- 3 · Grant Sites.Selected (admin) ----------
  { id: 'list-grants', group: 3, who: 'user', admin: true, site: true, title: 'List app grants on the site', method: 'GET',
    path: '/sites/{siteId}/permissions', perm: 'Sites.FullControl.All (delegated, admin only)',
    explain: 'The per-site grants that make <code>Sites.Selected</code> useful. SharePoint\'s own UI never shows these.',
    capture: [{ var: 'permId', list: (b) => b?.value?.map((p) => ({ id: p.id, label: `${(p.grantedToIdentitiesV2 ?? p.grantedToIdentities ?? [])[0]?.application?.displayName ?? p.id} (${(p.roles ?? []).join(',')})` })) }],
    expect: per({
      research: { admin: 'ingestion app · read', _other: 'token refused — Sites.FullControl.All is consented for the admin only (AADSTS65001)' },
      finance: { admin: 'ingestion app · read', _other: 'token refused (AADSTS65001)' },
      hr: { admin: 'empty list — never granted', _other: 'token refused (AADSTS65001)' },
      llmlab: { admin: '400 notSupported — grants exist only on site collections; Research\'s grant covers the subsite', _other: 'token refused (AADSTS65001)' },
    }) },
  { id: 'get-grant', group: 3, who: 'user', admin: true, site: true, title: 'Get one grant', method: 'GET',
    path: '/sites/{siteId}/permissions/{permId}', perm: 'Sites.FullControl.All (delegated, admin only)',
    explain: 'One grant: <code>roles</code> (read / write / manage / fullcontrol) and the app it was granted to.',
    expect: per({ '*': { admin: '200', _other: 'token refused (AADSTS65001)' } }) },
  { id: 'create-grant', group: 3, who: 'user', admin: true, site: true, write: true, title: 'Grant the ingestion app', method: 'POST',
    path: '/sites/{siteId}/permissions', perm: 'Sites.FullControl.All (delegated, admin only)',
    body: () => ({ roles: ['read'], grantedToIdentities: [{ application: { id: '{appId}', displayName: 'SharePoint ingestion (Sites.Selected)' } }] }),
    explain: 'Gives the ingestion app <b>read</b> on this site collection only. Try it on <b>HR</b>: <i>Get the site as the app</i> then returns 200 instead of 403. Revoke it again afterwards (or re-run <code>node scripts/setup/index.mjs --only sharepoint</code>, which restores the demo state).',
    capture: [{ var: 'permId', one: (b) => b?.id && { id: b.id, label: 'new grant' } }],
    expect: per({ hr: { admin: '201 Created — then "Get the site as the app" on HR returns 200. Revoke afterwards', _other: 'token refused (AADSTS65001)' }, llmlab: { admin: '400 notSupported — grant the site collection (Research)', _other: 'token refused (AADSTS65001)' }, '*': { admin: '201 Created (a second grant if one exists)', _other: 'token refused (AADSTS65001)' } }) },
  { id: 'update-grant', group: 3, who: 'user', admin: true, site: true, write: true, title: 'Change the grant\'s role', method: 'PATCH',
    path: '/sites/{siteId}/permissions/{permId}', perm: 'Sites.FullControl.All (delegated, admin only)', body: () => ({ roles: ['write'] }),
    explain: 'Roles: <code>read</code>, <code>write</code>, <code>manage</code>, <code>fullcontrol</code>. The indexer needs only <code>read</code> (validated).',
    expect: per({ '*': { admin: '200', _other: 'token refused (AADSTS65001)' } }) },
  { id: 'delete-grant', group: 3, who: 'user', admin: true, site: true, write: true, title: 'Revoke the grant', method: 'DELETE',
    path: '/sites/{siteId}/permissions/{permId}', perm: 'Sites.FullControl.All (delegated, admin only)',
    explain: 'Removes the app\'s access to this site. Chunks already in the index stay until the indexer is reset or the documents are deleted.',
    expect: per({ '*': { admin: '204 No Content', _other: 'token refused (AADSTS65001)' } }) },

  // ---------- 4 · Validate as the ingestion app ----------
  { id: 'app-token', group: 4, who: 'app', title: 'Ingestion app token', method: 'POST', path: 'login.microsoftonline.com/…/oauth2/v2.0/token',
    perm: '— (federated credential, no secret)',
    explain: 'The web app\'s managed identity token is the <code>client_assertion</code>; Entra returns an app-only token for the ingestion app. <code>roles: ["Sites.Selected"]</code> — tenant-wide consent, yet no site access by itself.',
    expect: per({ '*': { all: 'roles: Sites.Selected — the same for everyone (the app doesn\'t know who you are)' } }) },
  { id: 'app-get-site', group: 4, who: 'app', site: true, title: 'Get the site as the app', method: 'GET',
    path: '/sites/{host}:{sitePath}?$select=id,displayName,webUrl', perm: 'Sites.Selected + site grant',
    explain: 'The core proof: same consent for every site, but only granted sites answer.',
    expect: per({ hr: { all: '403 — no Sites.Selected grant' }, '*': { all: '200 — granted' } }) },
  { id: 'app-list-root', group: 4, who: 'app', site: true, title: 'List folders as the app', method: 'GET',
    path: '/sites/{siteId}/drive/root/children?$select=id,name,folder,webUrl', perm: 'Sites.Selected + site grant',
    explain: 'The app sees <b>every</b> folder, whoever you are — that\'s why the index must store each document\'s ACL and Azure AI Search trims at query time.',
    capture: [{ var: 'itemId', list: (b) => b?.value?.map((i) => ({ id: i.id, label: i.name })) }],
    expect: per({ research: { all: 'Public, Quantum, Bio' }, llmlab: { all: 'Papers, Drafts' }, finance: { all: 'Reports' }, hr: { all: '403' } }) },
  { id: 'app-get-grants', group: 4, who: 'app', site: true, title: 'Read the site\'s grants as the app', method: 'GET',
    path: '/sites/{siteId}/permissions', perm: 'Sites.Selected + site grant',
    explain: 'A <code>read</code> grant doesn\'t let the app see or change grants — it can\'t widen its own access.',
    expect: per({ hr: { all: '403 (site not granted)' }, '*': { all: '403 — read grant can\'t read permissions' } }) },
  { id: 'app-item-permissions', group: 4, who: 'app', admin: true, site: true, title: 'Folder permissions as the app', method: 'GET',
    path: '/sites/{siteId}/drive/items/{itemId}/permissions', perm: 'Sites.Selected + site grant · admins only in this app',
    explain: 'What the indexer reads for each item: the effective permissions it writes to <code>UserIds</code> / <code>GroupIds</code>.',
    expect: per({ hr: { admin: '403 — no grant', _other: '403 from this app (admins only)' }, '*': { admin: '200 — Entra groups, users and SharePoint site groups', _other: '403 from this app (admins only)' } }) },
  { id: 'app-sp-sitegroups', group: 4, who: 'app', site: true, title: 'SharePoint site groups (SharePoint REST)', method: 'GET',
    path: '{siteUrl}/_api/web/sitegroups?$select=Id,Title,OwnerTitle', perm: 'SharePoint Sites.Selected + site grant',
    explain: 'SharePoint groups exist only in SharePoint REST, which is why the app also needs <b>SharePoint</b> API permissions. The <code>Id</code> is the number in <code>spg:&lt;site&gt;:&lt;Id&gt;</code> in the index. Note HR: this works <b>without</b> a site grant — SharePoint <code>User.Read.All</code> (needed to resolve SharePoint groups at query time) reads groups and members on every site, but no content.',
    capture: [{ var: 'groupId', list: (b) => b?.value?.map((g) => ({ id: String(g.Id), label: g.Title })) }],
    expect: per({ hr: { all: '200 even without a grant (SharePoint User.Read.All) — Owners = 3, Visitors = 4, Members = 5' }, '*': { all: 'Owners = 3, Visitors = 4, Members = 5' } }) },
  { id: 'app-sp-group-users', group: 4, who: 'app', admin: true, site: true, title: 'Members of a SharePoint group', method: 'GET',
    path: '{siteUrl}/_api/web/sitegroups/getbyid({groupId})/users?$select=Id,Title,Email,PrincipalType', perm: 'SharePoint Sites.Selected + site grant · admins only in this app',
    explain: 'The query-time lookup Azure AI Search does (through <code>sharePointConnectorAppRegistration</code>) to decide whether you are in an <code>spg:</code> group.',
    expect: per({ finance: { admin: 'group 5 (Members): Bob', _other: '403 from this app (admins only)' }, hr: { admin: '200 even without a grant — group 3 (Owners): the admin', _other: '403 from this app (admins only)' }, '*': { admin: '200 — group 3 (Owners): the admin', _other: '403 from this app (admins only)' } }) },
  { id: 'app-sp-roleassignments', group: 4, who: 'app', admin: true, site: true, title: 'Site role assignments (SharePoint REST)', method: 'GET',
    path: '{siteUrl}/_api/web/roleassignments?$expand=Member,RoleDefinitionBindings', perm: 'SharePoint Sites.Selected + site grant · admins only in this app',
    explain: 'The site\'s role assignments as SharePoint stores them. A <code>read</code> grant is <b>not</b> enough to enumerate them — the indexer gets each item\'s effective permissions through Graph instead (<i>Folder permissions as the app</i>). App grants never appear in role assignments anyway.',
    expect: per({ '*': { admin: '403 Access denied — a read grant can\'t list role assignments', _other: '403 from this app (admins only)' } }) },

  // ---------- 5 · Validate in Azure AI Search ----------
  { id: 'search-as-you', group: 5, who: 'search', title: 'Search the index as you', method: 'POST', path: '/api/search',
    body: () => ({ q: 'AURORA', mode: 'keyword', top: 5 }), perm: 'your token in x-ms-query-source-authorization',
    explain: 'The end of the chain: the same codeword returns chunks only if SharePoint lets you read the document. Change <code>q</code> to BLUEBIRD, KESTREL, WREN, HERON, MAGPIE, NIGHTJAR or OSPREY.',
    expect: per({ '*': { alice: 'AURORA: found', bob: 'AURORA: nothing', carol: 'AURORA: nothing', admin: 'AURORA: nothing unless in Quantum team' } }) },
  { id: 'search-elevated', group: 5, who: 'search', admin: true, title: 'Stored ACLs (elevated read)', method: 'POST', path: '/api/admin/search',
    body: () => ({ q: 'AURORA' }), perm: 'x-ms-enable-elevated-read · Search Index Data Contributor · admins only',
    explain: 'Bypasses trimming to show the <code>UserIds</code> / <code>GroupIds</code> stored on each chunk, with names resolved.',
    expect: per({ '*': { admin: 'chunks with UserIds / GroupIds (needs Search Index Data Contributor)', _other: '403 (admins only)' } }) },
];

const GROUPS = {
  1: ['Who am I', 'your identity, as Azure AI Search sees it'],
  2: ['Discover the site — as you', 'delegated Graph, trimmed by SharePoint'],
  3: ['Grant Sites.Selected — admin', 'delegated Graph with Sites.FullControl.All'],
  4: ['Validate as the ingestion app', 'app-only, federated credential, fixed calls'],
  5: ['Validate in Azure AI Search', 'the result of all of the above'],
};
const WHO = { user: ['👤', 'you (delegated)'], app: ['🤖', 'ingestion app (app-only)'], search: ['🔎', 'Azure AI Search'], local: ['🔍', 'local'] };

let ctx;
let current = OPS[0];
let siteKey = 'research';
let vars = {};
let mounted = false;

const esc = (s) => ctx.esc(s);
function fill(str) {
  const site = ctx.cfg().sites.find((s) => s.key === siteKey);
  const u = site?.url ? new URL(site.url) : null;
  const all = { ...vars, host: u?.hostname, sitePath: u?.pathname, siteUrl: site?.url, appId: ctx.cfg().ingestClientId };
  return str.replace(/\{(\w+)\}/g, (m, k) => all[k] ?? m);
}
const persona = () => ctx.persona() ?? (ctx.me()?.isAdmin ? 'admin' : null);

function decode(token) {
  const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(p.padEnd(p.length + ((4 - (p.length % 4)) % 4), '=')))));
}

export function mountLab(context) {
  ctx = context;
}

export function loadLab() {
  if (!mounted) {
    mounted = true;
    const $ = ctx.$;
    $('#labSite').innerHTML = ctx.cfg().sites.filter((s) => s.url).map((s) =>
      `<option value="${esc(s.key)}">${s.parent ? '↳ ' : ''}${esc(s.name)}${s.granted ? '' : ' (not granted)'}</option>`).join('');
    $('#labSite').onchange = (e) => { siteKey = e.target.value; vars = {}; renderVars(); select(current.id); };
    $('#labRun').onclick = run;
    $('#labReset').onclick = () => select(current.id);
    $('#labCopy').onchange = copySnippet;
  }
  renderNav();
  select(current.id);
}

function renderNav() {
  const admin = Boolean(ctx.me()?.isAdmin);
  ctx.$('#labNav').innerHTML = Object.entries(GROUPS).map(([g, [title, sub]]) => `
    <div class="lab-group"><div class="lab-group-title">${g} · ${esc(title)}</div><div class="muted small">${esc(sub)}</div>
      ${OPS.filter((o) => o.group === Number(g)).map((o) => `
        <button class="lab-op${o.id === current.id ? ' active' : ''}" data-op="${o.id}">
          <span class="m m-${o.method.toLowerCase()}">${o.method === 'LOCAL' ? 'JWT' : o.method}</span>
          <span class="t">${WHO[o.who][0]} ${esc(o.title)}</span>
          ${o.admin ? `<span class="lock" title="${admin ? 'admin operation' : 'admins only — try it to see why'}">${admin ? '🛡' : '🔒'}</span>` : ''}
        </button>`).join('')}
    </div>`).join('');
  ctx.$$('#labNav .lab-op').forEach((b) => (b.onclick = () => select(b.dataset.op)));
}

function select(id) {
  current = OPS.find((o) => o.id === id) ?? OPS[0];
  const $ = ctx.$;
  ctx.$$('#labNav .lab-op').forEach((b) => b.classList.toggle('active', b.dataset.op === current.id));
  const editable = current.who === 'user';
  $('#labTitle').innerHTML = `${WHO[current.who][0]} ${esc(current.title)} <span class="pill">${esc(WHO[current.who][1])}</span>${current.admin ? ' <span class="pill bad">admin</span>' : ''}${current.write ? ' <span class="pill bad">changes SharePoint</span>' : ''}`;
  $('#labExplain').innerHTML = `${current.explain}<div class="muted small">Permission: ${esc(current.perm)}</div>`;
  $('#labSiteWrap').classList.toggle('dim', !current.site);
  $('#labSiteWrap').title = current.site ? '' : 'Not used by this operation';
  $('#labMethod').innerHTML = (current.custom ? ['GET', 'POST', 'PATCH', 'DELETE'] : [current.method]).map((m) => `<option>${m}</option>`).join('');
  $('#labMethod').disabled = !current.custom;
  const base = current.who === 'user' || (current.who === 'app' && current.path.startsWith('/')) ? GRAPH : '';
  $('#labUrl').value = `${base}${fill(current.path)}`;
  $('#labUrl').readOnly = !editable;
  const body = current.body?.();
  $('#labBodyWrap').classList.toggle('hidden', !body && !current.custom);
  $('#labBody').value = body ? JSON.stringify(JSON.parse(fill(JSON.stringify(body))), null, 2) : '';
  $('#labBody').readOnly = current.who === 'app';
  $('#labScopeWrap').classList.toggle('hidden', !current.custom);
  $('#labCopyWrap').classList.toggle('hidden', current.who !== 'user');
  renderExpect();
  renderVars();
  $('#labResult').innerHTML = '<div class="muted small">Not run yet.</div>';
}

function renderExpect() {
  const m = current.expect?.(siteKey);
  if (!m) { ctx.$('#labExpect').innerHTML = ''; return; }
  const me = persona();
  const rows = m.all ? [['everyone', m.all, true]]
    : ALL.map((p) => [LABEL[p], m[p] ?? (p === 'admin' ? null : m._other), p === me]).filter(([, v]) => v);
  ctx.$('#labExpect').innerHTML = `<div class="small"><b>Expected</b>${current.site ? ` <span class="muted">for ${esc(ctx.cfg().sites.find((s) => s.key === siteKey)?.name ?? siteKey)}</span>` : ''}</div>
    <table class="expect">${rows.map(([who, v, mine]) => `<tr class="${mine ? 'me' : ''}"><td>${esc(who)}${mine ? ' <span class="badge">you</span>' : ''}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
}

function renderVars() {
  const names = ['siteId', 'driveId', 'itemId', 'permId', 'groupId'];
  ctx.$('#labVars').innerHTML = names.map((n) => `
    <label class="var"><span>${n}</span><input data-var="${n}" value="${esc(vars[n] ?? '')}" placeholder="—" spellcheck="false"></label>`).join('');
  ctx.$$('#labVars input').forEach((i) => (i.onchange = () => { vars[i.dataset.var] = i.value.trim() || undefined; select(current.id); }));
}

function setVar(name, value, also = {}) {
  vars[name] = value;
  for (const [k, v] of Object.entries(also)) if (v) vars[k] = v;
  renderVars();
}

async function graphCall(method, url, body, scopes) {
  const t = await tryToken(scopes);
  const request = { method, url, headers: { Authorization: 'Bearer <your delegated Graph token — redacted>', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body } : {}) };
  if (t.error) {
    return { request, tokenError: t.error, response: { status: 'no token', ms: 0, body: {
      note: 'Entra ID refused to issue a token with the required permission for you, so the request was never sent.',
      ...t.error,
    } } };
  }
  const started = performance.now();
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${t.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { request, response: { status: res.status, ms: Math.round(performance.now() - started), headers: { 'request-id': res.headers.get('request-id') ?? undefined }, body: parsed } };
}

async function run() {
  const $ = ctx.$;
  const method = $('#labMethod').value;
  let body = null;
  if (!$('#labBodyWrap').classList.contains('hidden') && $('#labBody').value.trim()) {
    try { body = JSON.parse(fill($('#labBody').value)); } catch (e) { ctx.toast(`Body is not valid JSON: ${e.message}`, true); return; }
  }
  if (current.write && !confirm(`${method} ${fill($('#labUrl').value)}\n\nThis changes the SharePoint site's app grants. Continue?`)) return;
  $('#labResult').innerHTML = '<span class="spinner"></span> Running…';
  let result;
  try {
    if (current.who === 'local') {
      const t = await tryToken(ctx.cfg().graphReadScopes);
      const admin = ctx.me()?.isAdmin ? await tryToken([ctx.cfg().graphSiteGrantsScope]) : null;
      const pick = (c) => ({ aud: c.aud, appid: c.appid, app_displayname: c.app_displayname, upn: c.upn, oid: c.oid, scp: c.scp?.split(' '), exp: new Date(c.exp * 1000).toISOString() });
      result = { request: { note: 'Nothing sent: tokens are decoded in your browser.' }, response: { status: 'decoded', ms: 0, body: {
        graphToken: t.error ? t.error : pick(decode(t.token)),
        ...(admin ? { adminToken: admin.error ? admin.error : pick(decode(admin.token)) } : {}),
      } } };
    } else if (current.who === 'user') {
      const url = fill($('#labUrl').value.trim());
      if (/\{\w+\}/.test(url)) { $('#labResult').innerHTML = `<div class="errbox">Missing ${esc(url.match(/\{(\w+)\}/g).join(', '))} — run the operation that captures it first, or type a value above.</div>`; return; }
      if (!url.startsWith('https://graph.microsoft.com/')) { $('#labResult').innerHTML = '<div class="errbox">Only https://graph.microsoft.com URLs can be called with your Graph token.</div>'; return; }
      const scopes = current.admin || (current.custom && $('#labScopeSel').value === 'admin') ? [ctx.cfg().graphSiteGrantsScope] : ctx.cfg().graphReadScopes;
      result = await graphCall(method, url, body, scopes);
    } else if (current.who === 'app') {
      const started = performance.now();
      try {
        result = await ctx.api('/api/lab/run', { op: current.id, site: siteKey, itemId: vars.itemId, groupId: vars.groupId });
      } catch (e) {
        result = { request: { method: 'POST', url: '/api/lab/run', body: { op: current.id, site: siteKey } }, response: { status: e.status ?? 'error', ms: Math.round(performance.now() - started), body: e.data ?? { error: e.message } } };
      }
    } else {
      const started = performance.now();
      try {
        const data = await ctx.api(current.path, body);
        result = data.raw
          ? { request: data.raw.request, response: { status: data.raw.response?.status, ms: data.raw.response?.tookMs, body: data.raw.response?.body } }
          : { request: { method: 'POST', url: current.path, body }, response: { status: 200, ms: Math.round(performance.now() - started), body: data } };
      } catch (e) {
        result = { request: { method: 'POST', url: current.path, body }, response: { status: e.status ?? 'error', ms: Math.round(performance.now() - started), body: e.data ?? { error: e.message } } };
      }
    }
  } catch (e) {
    result = { request: {}, response: { status: 'error', body: { error: e.message } } };
  }
  renderResult(result);
}

function renderResult(r) {
  const s = r.response?.status;
  const cls = typeof s === 'number' ? (s < 300 ? 'ok' : 'bad') : (s === 'decoded' ? 'ok' : 'bad');
  const picks = (current.capture ?? []).flatMap((c) => {
    const body = r.response?.body;
    if (typeof s !== 'number' || s >= 300) return [];
    if (c.one) { const v = c.one(body); if (v) setVar(c.var, v.id); return v ? [{ var: c.var, items: [v], auto: true }] : []; }
    const items = (c.list(body) ?? []).filter((x) => x?.id);
    if (items.length) setVar(c.var, items[0].id, items[0].also);
    return items.length ? [{ var: c.var, items }] : [];
  });
  ctx.$('#labResult').innerHTML = `
    <div class="lab-status"><span class="pill ${cls}">${typeof s === 'number' ? `HTTP ${s}` : esc(s ?? '?')}</span>
      ${r.response?.ms != null ? `<span class="muted small">${r.response.ms} ms</span>` : ''}
      ${r.response?.headers?.['request-id'] ? `<span class="muted small">request-id ${esc(r.response.headers['request-id'])}</span>` : ''}
      ${r.note ? `<span class="warn-text small">${esc(r.note)}</span>` : ''}</div>
    ${picks.map((p) => `<div class="lab-picks"><span class="muted small">${esc(p.var)} ←</span> ${p.items.map((it, i) =>
      `<button class="chip${i === 0 ? ' active' : ''}" data-var="${esc(p.var)}" data-id="${esc(it.id)}" data-also='${esc(JSON.stringify(it.also ?? {}))}' title="${esc(it.id)}">${esc(it.label ?? it.id)}</button>`).join('')}</div>`).join('')}
    <div class="raw-grid">
      <div class="raw-box"><div class="raw-head">Request</div><pre class="json">${ctx.jsonHtml(r.request ?? null)}</pre></div>
      <div class="raw-box"><div class="raw-head">Response</div><pre class="json">${ctx.jsonHtml(r.response?.body ?? null)}</pre></div>
    </div>`;
  ctx.$$('#labResult .lab-picks .chip').forEach((b) => (b.onclick = () => {
    setVar(b.dataset.var, b.dataset.id, JSON.parse(b.dataset.also || '{}'));
    b.parentElement.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === b));
    ctx.toast(`${b.dataset.var} = ${b.textContent}`);
  }));
}

function copySnippet(e) {
  const kind = e.target.value;
  e.target.value = '';
  const method = ctx.$('#labMethod').value;
  const url = fill(ctx.$('#labUrl').value.trim());
  const body = ctx.$('#labBody').value.trim() && !ctx.$('#labBodyWrap').classList.contains('hidden') ? JSON.stringify(JSON.parse(fill(ctx.$('#labBody').value))) : '';
  const scope = current.admin ? 'Sites.FullControl.All' : 'Sites.Read.All';
  const snippets = {
    ps: `Connect-MgGraph -Scopes ${scope}\nInvoke-MgGraphRequest -Method ${method} -Uri "${url}"${body ? ` -Body '${body}' -ContentType 'application/json'` : ''}`,
    az: `az rest --method ${method.toLowerCase()} --url "${url}"${body ? ` --body '${body}'` : ''}`,
    http: `${method} ${url}${body ? `\nContent-Type: application/json\n\n${JSON.stringify(JSON.parse(body), null, 2)}` : ''}`,
  };
  if (kind === 'ge') {
    const path = url.replace(GRAPH, '').replace(/^\//, '');
    window.open(`https://developer.microsoft.com/graph/graph-explorer?request=${encodeURIComponent(path)}&method=${method}&version=v1.0&GraphUrl=https://graph.microsoft.com${body ? `&requestBody=${btoa(body)}` : ''}`, '_blank', 'noopener');
    return;
  }
  if (!snippets[kind]) return;
  navigator.clipboard.writeText(snippets[kind]).then(() => ctx.toast('Copied'), () => ctx.toast('Copy failed', true));
}
