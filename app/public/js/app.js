import { initAuth, signIn, signOut, currentAccount, getToken } from './auth.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let cfg;
let me = null;
let mode = 'hybrid';
const chatHistory = [];

const SUGGESTED_SEARCHES = [
  { q: 'BLUEBIRD', hint: 'Research/Public codeword', mode: 'keyword' },
  { q: 'AURORA', hint: 'Research/Quantum codeword', mode: 'keyword' },
  { q: 'KESTREL', hint: 'Research/Bio codeword', mode: 'keyword' },
  { q: 'NIGHTJAR', hint: 'Finance codeword', mode: 'keyword' },
  { q: 'OSPREY', hint: 'HR codeword (never indexed)', mode: 'keyword' },
  { q: 'superconducting qubits', hint: 'Quantum papers', mode: 'hybrid' },
  { q: 'gene expression images', hint: 'Bio papers', mode: 'hybrid' },
  { q: 'probability of default credit cards', hint: 'Finance papers', mode: 'hybrid' },
  { q: 'chunk retrieval boundaries', hint: 'Public papers', mode: 'hybrid' },
];
const SUGGESTED_QUESTIONS = [
  'Which codewords can I see, and which folders do they belong to?',
  'What does the superconducting quantum processor paper achieve?',
  'How do the finance papers model loss given default?',
  'Summarise the gene expression to image learning paper.',
];
const MATRIX = {
  cols: [
    ['Research / Public', 'BLUEBIRD'],
    ['Research / Quantum', 'AURORA'],
    ['Research / Bio', 'KESTREL'],
    ['Finance / Reports', 'NIGHTJAR'],
    ['HR / Confidential', 'OSPREY'],
  ],
  rows: [
    ['alice', 'Alice — Quantum team (Entra group)', [1, 1, 0, 0, 0]],
    ['bob', 'Bob — Finance “Members” (SharePoint site group)', [1, 0, 0, 1, 0]],
    ['carol', 'Carol — shared directly on Bio', [1, 0, 1, 0, 0]],
  ],
};

// ---------- helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
// Escape everything, then re-enable only the <mark> tags added by Azure AI Search.
function highlighted(s) {
  return esc(s).replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
}
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 5000);
}
function siteKey(url = '') {
  const u = url.toLowerCase();
  return u.endsWith('-research') ? 'research' : u.endsWith('-finance') ? 'finance' : u.endsWith('-hr') ? 'hr' : 'other';
}
function siteName(url) {
  return cfg.sites.find((s) => s.key === siteKey(url))?.name ?? url;
}
function folderOf(path = '') {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}
function persona() {
  const upn = (me?.upn ?? currentAccount()?.username ?? '').toLowerCase();
  return ['alice', 'bob', 'carol'].find((p) => upn.startsWith(`${p}.`)) ?? null;
}

async function api(path, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${await getToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

// Pretty-print JSON with light syntax colouring (escaped first, so it's safe as innerHTML).
function jsonHtml(value) {
  return esc(JSON.stringify(value, null, 2)).replace(
    /(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, lit, num) => {
      if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
      if (lit) return `<span class="j-lit">${lit}</span>`;
      return `<span class="j-num">${num}</span>`;
    });
}

function showRaw(raw) {
  if (!raw) return $('#rawPanel').classList.add('hidden');
  $('#rawPanel').classList.remove('hidden');
  const r = raw.response ?? {};
  $('#rawMeta').textContent = `· HTTP ${r.status ?? '?'}${r.tookMs != null ? ` · ${r.tookMs} ms` : ''} · ${raw.request?.body?.queryType ?? 'simple'}${raw.request?.body?.vectorQueries ? ' + vector' : ''}`;
  $('#rawReq').innerHTML = jsonHtml(raw.request);
  $('#rawRes').innerHTML = jsonHtml(r.body ?? null);
  $('#rawReq')._json = JSON.stringify(raw.request, null, 2);
  $('#rawRes')._json = JSON.stringify(r.body ?? null, null, 2);
}

// ---------- shell ----------
function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('main > section.panel').forEach((s) => s.classList.add('hidden'));
  $(`#tab-${name}`)?.classList.remove('hidden');
  if (name === 'proof') loadProof();
  if (name === 'admin') loadAdmin();
  if (name === 'how') renderMatrix();
  history.replaceState(null, '', `#${name}`);
}

function renderUser() {
  const acc = currentAccount();
  const area = $('#userArea');
  if (!acc) {
    area.innerHTML = '<button class="btn primary" id="signInBtn">Sign in</button>';
    $('#signInBtn').onclick = doSignIn;
    $('#hero').classList.remove('hidden');
    $$('main > section.panel').forEach((s) => s.classList.add('hidden'));
    $('#tabs').classList.add('hidden');
    return;
  }
  $('#hero').classList.add('hidden');
  $('#tabs').classList.remove('hidden');
  const name = me?.name ?? acc.name ?? acc.username;
  const groups = (me?.groups ?? []).map((g) => `<span class="badge">${esc(g.name)}</span>`).join(' ');
  area.innerHTML = `
    <div class="avatar">${esc(name[0] ?? '?')}</div>
    <div>
      <div class="user-name">${esc(name)}</div>
      <div class="user-upn">${esc(acc.username)}</div>
      <div class="badges">${groups || '<span class="badge">no groups</span>'}</div>
    </div>
    <button class="btn small" id="signOutBtn">Sign out</button>`;
  $('#signOutBtn').onclick = () => signOut();
  $('#adminTabBtn').classList.toggle('hidden', !me?.isAdmin);
}

async function doSignIn() {
  try {
    await signIn();
    await afterSignIn();
  } catch (e) {
    toast(`Sign-in failed: ${e.message}`, true);
  }
}

async function afterSignIn() {
  renderUser();
  try {
    me = await api('/api/me');
  } catch (e) {
    toast(`Profile lookup failed: ${e.message}`, true);
  }
  renderUser();
  const want = location.hash.slice(1);
  showTab(['search', 'ask', 'proof', 'how', 'admin'].includes(want) && (want !== 'admin' || me?.isAdmin) ? want : 'search');
}

// ---------- search ----------
function setMode(m) {
  mode = m;
  $$('#mode button').forEach((x) => x.classList.toggle('active', x.dataset.mode === m));
}

function renderSuggestions() {
  $('#suggestions').innerHTML = SUGGESTED_SEARCHES.map((s, i) => `<span class="chip" data-i="${i}" title="${esc(s.hint)} · ${s.mode}">${esc(s.q)}</span>`).join('');
  $$('#suggestions .chip').forEach((c) => (c.onclick = () => {
    const s = SUGGESTED_SEARCHES[Number(c.dataset.i)];
    $('#q').value = s.q;
    setMode(s.mode);
    runSearch();
  }));
  $('#askSuggestions').innerHTML = SUGGESTED_QUESTIONS.map((q) => `<span class="chip">${esc(q)}</span>`).join('');
  $$('#askSuggestions .chip').forEach((c) => (c.onclick = () => { $('#chatQ').value = c.textContent; ask(); }));
}

async function runSearch() {
  const q = $('#q').value.trim();
  $('#searchMeta').innerHTML = '<span class="spinner"></span> searching as you…';
  $('#results').innerHTML = '';
  try {
    const data = await api('/api/search', { q: q || '*', mode, top: 20 });
    showRaw(data.raw);
    // group chunks by source document
    const docs = new Map();
    for (const r of data.results) {
      const k = r.url ?? r.parentId;
      if (!docs.has(k)) docs.set(k, { ...r, chunks: [] });
      docs.get(k).chunks.push(r);
    }
    // Keyword hits carry @search.highlights; vector-only neighbours (hybrid) don't.
    for (const d of docs.values()) d.keywordHit = d.chunks.some((c) => c.highlight);
    const keywordDocs = [...docs.values()].filter((d) => d.keywordHit).length;
    $('#searchMeta').textContent = `${data.count} matching chunk(s) you can access · ${docs.size} document(s)`
      + (mode === 'hybrid' && q && q !== '*' ? ` (${keywordDocs} with a keyword match)` : '') + ` · ${data.tookMs} ms · ${mode}`;
    if (!docs.size) {
      $('#results').innerHTML = `
        <div class="empty"><div class="big">🔒</div>
          <h3>No results for you</h3>
          <p>Either nothing matches, or every matching chunk is protected by permissions you don't have.<br/>
          Azure AI Search removed them before ranking — the app never received them.</p></div>`;
      return;
    }
    const noKeyword = mode === 'hybrid' && q && q !== '*' && keywordDocs === 0
      ? `<div class="infobox">🔒 <b>No document you can access contains “${esc(q)}”.</b> Hybrid search also runs a
          <b>vector</b> query, which always returns the nearest chunks <i>you</i> are allowed to read, so the list below is
          “closest by meaning”, not a match. Chunks from folders you can't access were removed before ranking — compare with
          <b>Keyword</b> mode, or sign in as a persona who has access.</div>`
      : '';
    $('#results').innerHTML = noKeyword + [...docs.values()].map((d) => {
      const best = d.chunks.find((c) => c.highlight) ?? d.chunks[0];
      const snippet = best.caption || best.highlight || esc(best.chunk?.slice(0, 320));
      const key = siteKey(d.site);
      const matchBadge = mode === 'hybrid' && q && q !== '*'
        ? (d.keywordHit ? '<span class="badge match">keyword match</span>' : '<span class="badge vec">vector neighbour only</span>')
        : '';
      return `
        <article class="result${mode === 'hybrid' && !d.keywordHit && q && q !== '*' ? ' neighbour' : ''}">
          <div class="result-top">
            <a class="result-title" href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a>
            <span class="score">${d.score != null ? `score ${Number(d.score).toFixed(2)}` : ''}</span>
          </div>
          <div class="badges">
            <span class="badge site-${key}">${esc(siteName(d.site))}</span>
            ${folderOf(d.path) ? `<span class="badge">📁 ${esc(folderOf(d.path))}</span>` : ''}
            <span class="badge">${d.chunks.length} chunk(s)</span>
            ${matchBadge}
          </div>
          <div class="snippet">${highlighted(snippet)}</div>
        </article>`;
    }).join('');
  } catch (e) {
    $('#searchMeta').textContent = '';
    showRaw(e.data?.raw);
    $('#results').innerHTML = `<div class="errbox">${esc(e.message)}</div>`;
  }
}

// ---------- chat ----------
const CHAT_EMPTY = `
  <div class="chat-empty">
    <h3>Ask questions grounded in the documents <u>you</u> can read</h3>
    <p class="muted">Every question runs a <b>new</b> hybrid search with your token, so the model only ever receives
      ACL-trimmed chunks. The last few messages are passed along as conversation context; nothing is stored on the server.</p>
  </div>`;

function renderChat() {
  const log = $('#chatLog');
  $('#newChat').disabled = !chatHistory.length;
  if (!chatHistory.length) {
    log.innerHTML = CHAT_EMPTY;
    return;
  }
  log.innerHTML = chatHistory.map((m) => {
    if (m.role === 'user') return `<div class="msg user">${esc(m.content)}</div>`;
    if (m.pending) return '<div class="msg bot typing">Retrieving the chunks you can access…</div>';
    const sources = (m.sources ?? []).map((s) => `<div class="src"><b>[${s.n}]</b> <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> · ${esc(siteName(s.site))} / ${esc(folderOf(s.path))}</div>`).join('');
    const searched = m.searched != null ? `🔎 searched “${esc(m.searched)}” as you (hybrid) · ` : '';
    return `<div class="msg bot">${esc(m.content)}${sources ? `<div class="sources">${sources}</div>` : ''}<div class="src">${searched}${m.retrieved ?? 0} chunk(s) retrieved after ACL trimming</div></div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;
  window.scrollTo(0, document.body.scrollHeight);
}

function newConversation() {
  if (chatHistory.some((m) => m.pending)) return;
  chatHistory.length = 0;
  renderChat();
  $('#chatQ').focus();
}

async function ask() {
  const q = $('#chatQ').value.trim();
  if (!q || chatHistory.some((m) => m.pending)) return;
  $('#chatQ').value = '';
  chatHistory.push({ role: 'user', content: q });
  const pending = { role: 'assistant', pending: true };
  chatHistory.push(pending);
  renderChat();
  try {
    const msgs = chatHistory.filter((m) => !m.pending).map(({ role, content }) => ({ role, content }));
    const data = await api('/api/chat', { messages: msgs });
    Object.assign(pending, { pending: false, content: data.answer, sources: data.sources, retrieved: data.retrieved, searched: data.searched });
  } catch (e) {
    Object.assign(pending, { pending: false, content: `Error: ${e.message}` });
  }
  renderChat();
}

// ---------- proof ----------
async function loadProof() {
  $('#proofCards').innerHTML = '<div class="card"><span class="spinner"></span> Calling Microsoft Graph as the ingestion app…</div>';
  $('#tokenInfo').innerHTML = '';
  try {
    const data = await api('/api/proof');
    if (data.tokenInfo) {
      $('#tokenInfo').innerHTML = `<div class="token-strip">
        <span class="muted">App-only token for</span> <b>${esc(data.tokenInfo.appDisplayName ?? data.tokenInfo.appId)}</b>
        <span class="muted">· roles claim:</span> ${data.tokenInfo.roles.map((r) => `<code>${esc(r)}</code>`).join(' ') || '<code>(none)</code>'}
        <span class="muted">· obtained with a federated credential (no secret)</span></div>`;
    } else if (data.tokenError) {
      $('#tokenInfo').innerHTML = `<div class="token-strip muted">Live Graph probe unavailable: ${esc(data.tokenError)}</div>`;
    }
    $('#proofCards').innerHTML = data.sites.map((s) => {
      const p = s.probe;
      const ix = s.indexer ?? {};
      const readable = p ? p.httpStatus === 200 : null;
      const ixOk = ix.status === 'success';
      const statusDot = (s.granted ? (readable !== false && ixOk) : (readable !== true && !ixOk)) ? 'ok' : 'warn';
      return `
        <div class="card proof-card">
          <div class="status"><span class="dot ${statusDot}"></span>${esc(s.name)}</div>
          <dl class="kv">
            <dt>Site grant</dt><dd>${s.granted ? '✅ granted (Sites.Selected)' : '⛔ <b>not granted</b>'}</dd>
            <dt>Admin consent</dt><dd>✅ Sites.Selected (tenant-wide, same for all sites)</dd>
            <dt>Graph probe</dt><dd>${p ? `HTTP <b>${p.httpStatus}</b> (${p.ms} ms)` : '—'}</dd>
            <dt>Indexer</dt><dd>${esc(ix.status ?? '—')} · ${ix.itemsProcessed ?? 0} item(s)</dd>
            <dt>Last run</dt><dd>${ix.endTime ? new Date(ix.endTime).toLocaleString() : '—'}</dd>
          </dl>
          ${p?.items ? `<div class="okbox">Visible to the app: ${p.items.map(esc).join(', ')}</div>` : ''}
          ${p?.error ? `<div class="errbox">Graph: ${esc(p.error)}</div>` : ''}
          ${ix.error ? `<div class="errbox">Indexer: ${esc(ix.error.slice(0, 400))}</div>` : ''}
        </div>`;
    }).join('');
  } catch (e) {
    $('#proofCards').innerHTML = `<div class="errbox">${esc(e.message)}</div>`;
  }
}

// ---------- how ----------
const VIA = { user: '👤', 'entra-group': '👥', 'sp-group': '🟦' };

function designRow(upn) {
  const key = ['alice', 'bob', 'carol'].find((p) => upn.toLowerCase().startsWith(`${p}.`));
  return key ? MATRIX.rows.find(([k]) => k === key) : null;
}

function renderDesignMatrix() {
  const p = persona();
  $('#matrix').innerHTML = `
    <tr><th>Persona (design)</th>${MATRIX.cols.map(([f, c]) => `<th>${esc(f)}<br><small class="muted">${c}</small></th>`).join('')}</tr>
    ${MATRIX.rows.map(([key, label, cells]) => `
      <tr class="${key === p ? 'me' : ''}"><td>${esc(label)}${key === p ? ' <span class="badge">you</span>' : ''}</td>
      ${cells.map((v) => `<td class="${v ? 'yes' : 'no'}">${v ? '✔' : '—'}</td>`).join('')}</tr>`).join('')}`;
}

async function renderMatrix() {
  $('#matrixMeta').innerHTML = '<span class="spinner"></span> Reading ACLs from the index and resolving group memberships…';
  try {
    const data = await api('/api/matrix');
    const head = data.columns.map((c) => `
      <th>${esc(c.siteName)} / ${esc(c.folder)}<br><small class="muted">${esc(c.codeword)}</small>
        <div class="acl">${c.indexed === undefined
          ? (c.granted ? '' : '<span class="warn-text">no Sites.Selected grant</span>')
          : c.indexed
          ? esc(c.principals.join(' · '))
          : `<span class="warn-text">not indexed${c.granted ? '' : ' — no Sites.Selected grant'}</span>`}</div></th>`).join('');
    const rows = data.rows.map((r) => {
      const design = designRow(r.upn);
      const matches = design ? r.cells.every((c, i) => c.access === Boolean(design[2][i])) : null;
      const notes = [
        design ? (matches ? '<span class="pill ok">matches design</span>' : '<span class="pill bad">differs from design</span>') : '',
        r.notInSiteList.length ? `<span class="pill bad" title="Azure AI Search looks every user up in each indexed site; queries fail until the user is in the site's user list">⚠ not in user list: ${esc(r.notInSiteList.join(', '))}</span>` : '',
        ...r.warnings.map((w) => `<span class="pill bad">${esc(w)}</span>`),
      ].join(' ');
      const cells = r.cells.map((c) => {
        let live = '';
        if (c.verified !== undefined) {
          live = c.verified?.error
            ? `<div class="live bad">your query: error</div>`
            : `<div class="live ${c.verified === c.access ? 'ok' : 'bad'}">🔎 your query: ${c.verified ? 'found' : 'hidden'}</div>`;
        }
        return c.access
          ? `<td class="yes">✔<div class="via">${VIA[c.via] ?? ''} ${esc(c.label)}</div>${live}</td>`
          : `<td class="no">—${live}</td>`;
      }).join('');
      return `<tr class="${r.me ? 'me' : ''}"><td>${esc(r.displayName ?? r.upn)}${r.me ? ' <span class="badge">you</span>' : ''}
        <div class="muted small">${esc(r.upn)}</div>${notes}</td>${cells}</tr>`;
    }).join('');
    const p = persona();
    const designRows = data.scope === 'self' ? MATRIX.rows.filter(([key]) => key !== p).map(([, label, cells]) => `
      <tr class="design"><td>${esc(label)}<div><span class="pill">design — not computed for you</span></div></td>
      ${cells.map((v) => `<td class="${v ? 'yes' : 'no'}">${v ? '✔' : '—'}</td>`).join('')}</tr>`).join('') : '';
    $('#matrix').innerHTML = `<tr><th>Who</th>${head}</tr>${rows}${designRows}`;
    $('#matrixMeta').innerHTML = data.scope === 'self'
      ? `Your row: real ACL-trimmed queries with your token (${new Date(data.generatedAt).toLocaleTimeString()}, ${data.tookMs} ms).
         Computing every persona's row needs elevated read of the stored ACLs — sign in as a member of the demo admins group.`
      : `Computed ${new Date(data.generatedAt).toLocaleTimeString()} in ${data.tookMs} ms ·
      👤 direct permission · 👥 Entra group · 🟦 SharePoint site group${data.spError ? ` · <span class="warn-text">${esc(data.spError)}</span>` : ''}`;
  } catch (e) {
    $('#matrixMeta').innerHTML = `<span class="warn-text">Live computation failed (${esc(e.message)}). Showing the design matrix.</span>`;
    renderDesignMatrix();
  }
}

// ---------- admin ----------
async function loadAdmin() {
  loadIndexers();
  loadMembership();
}

async function loadIndexers() {
  $('#indexers').innerHTML = '<span class="spinner"></span>';
  try {
    const data = await api('/api/admin/indexers');
    const stats = data.stats ? `<p class="muted small">Index: ${data.stats.documentCount} chunks · ${(data.stats.storageSize / 1024 / 1024).toFixed(1)} MB</p>` : '';
    $('#indexers').innerHTML = stats + data.indexers.map((ix) => `
      <div class="ix-row">
        <div><b>${esc(ix.name)}</b><div class="muted small">${esc(ix.schedule?.interval ?? 'no schedule')}</div></div>
        <div class="small">
          <span class="dot ${ix.status === 'success' ? 'ok' : ix.status === 'inProgress' ? 'warn' : 'bad'}"></span>
          ${esc(ix.status)} · ${ix.itemsProcessed ?? 0} processed · ${ix.itemsFailed ?? 0} failed
          ${ix.endTime ? `<div class="muted">${new Date(ix.endTime).toLocaleString()}</div>` : ''}
        </div>
        <div class="ix-actions">
          ${ix.status === 'rejected' ? '<span class="badge">not granted</span>' : `
          <button class="btn small" data-ix="${ix.key}" data-action="run">Run now</button>
          <button class="btn small" data-ix="${ix.key}" data-action="resync" title="Re-read permissions for all items (needed after site/library/folder permission changes)">Resync ACLs</button>`}
        </div>
      </div>`).join('');
    $$('#indexers button[data-ix]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        await api(`/api/admin/indexers/${b.dataset.ix}/${b.dataset.action}`, {});
        toast(`${b.dataset.action} requested for ixr-${b.dataset.ix}${b.dataset.action === 'resync' ? ' — the next run refreshes ACLs' : ''}`);
        setTimeout(loadIndexers, 4000);
      } catch (e) {
        toast(e.message, true);
      } finally {
        b.disabled = false;
      }
    }));
  } catch (e) {
    $('#indexers').innerHTML = `<div class="errbox">${esc(e.message)}</div>`;
  }
}

async function graphCall(path, method = 'GET', body) {
  const token = await getToken([cfg.graphAdminScope]);
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 204) throw new Error(`Graph ${res.status}: ${(await res.json().catch(() => ({}))).error?.message ?? ''}`);
  return res.status === 204 ? null : res.json();
}

async function loadMembership() {
  const box = $('#membership');
  box.innerHTML = '<span class="spinner"></span>';
  try {
    const [staff, quantum] = await Promise.all([
      graphCall(`/groups/${cfg.groups.allStaff}/members?$select=id,displayName,userPrincipalName`),
      graphCall(`/groups/${cfg.groups.quantum}/members?$select=id`),
    ]);
    const inQuantum = new Set(quantum.value.map((m) => m.id));
    box.innerHTML = staff.value.map((u) => `
      <div class="member-row">
        <div><b>${esc(u.displayName)}</b><div class="muted small">${esc(u.userPrincipalName ?? '')}</div></div>
        ${inQuantum.has(u.id)
          ? `<button class="btn small danger" data-uid="${u.id}" data-op="remove">Remove from Quantum team</button>`
          : `<button class="btn small" data-uid="${u.id}" data-op="add">Add to Quantum team</button>`}
      </div>`).join('') || '<p class="muted">No personas yet — run the setup script.</p>';
    $$('#membership button').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        if (b.dataset.op === 'add') {
          await graphCall(`/groups/${cfg.groups.quantum}/members/$ref`, 'POST', { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${b.dataset.uid}` });
        } else {
          await graphCall(`/groups/${cfg.groups.quantum}/members/${b.dataset.uid}/$ref`, 'DELETE');
        }
        toast('Membership updated. Search resolves groups at query time — no re-index needed.');
        loadMembership();
      } catch (e) {
        toast(e.message, true);
        b.disabled = false;
      }
    }));
  } catch (e) {
    box.innerHTML = `<div class="errbox">${esc(e.message)}</div>`;
  }
}

async function adminSearch() {
  const out = $('#adminResults');
  out.innerHTML = '<span class="spinner"></span>';
  try {
    const data = await api('/api/admin/search', { q: $('#adminQ').value || '*', mode: 'keyword', top: 100 });
    const docs = new Map();
    for (const r of data.results) if (!docs.has(r.url)) docs.set(r.url, r);
    const chip = (id) => {
      const p = data.principals[id] ?? { kind: 'unknown', name: id };
      return `<span class="principal ${p.kind}" title="${esc(id)}">${esc(p.name)}</span>`;
    };
    out.innerHTML = `<p class="muted small">${data.count} chunk(s) in total (elevated read) · ${docs.size} document(s) shown</p>
      <table class="acl-table"><tr><th>Document</th><th>Site / folder</th><th>Allowed principals (UserIds + GroupIds)</th></tr>
      ${[...docs.values()].map((d) => `<tr>
        <td><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a></td>
        <td>${esc(siteName(d.site))} / ${esc(folderOf(d.path))}</td>
        <td>${[...d.userIds, ...d.groupIds].map(chip).join('') || '<span class="muted">none</span>'}</td></tr>`).join('')}
      </table>`;
  } catch (e) {
    out.innerHTML = `<div class="errbox">${esc(e.message)}</div>`;
  }
}

// ---------- boot ----------
async function boot() {
  cfg = await (await fetch('/api/config')).json();
  renderSuggestions();
  $('#heroSignIn').onclick = doSignIn;
  $$('#tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $$('#mode button').forEach((b) => (b.onclick = () => {
    setMode(b.dataset.mode);
    if ($('#q').value.trim()) runSearch();
  }));
  $('#searchForm').onsubmit = (e) => { e.preventDefault(); runSearch(); };
  $('#chatForm').onsubmit = (e) => { e.preventDefault(); ask(); };
  $('#newChat').onclick = newConversation;
  renderChat();
  $('#proofRefresh').onclick = loadProof;
  $$('[data-copy]').forEach((b) => (b.onclick = async () => {
    await navigator.clipboard.writeText($(`#${b.dataset.copy}`)._json ?? '');
    toast('Copied JSON');
  }));
  $('#matrixRefresh').onclick = renderMatrix;
  $('#ixRefresh').onclick = loadIndexers;
  $('#adminSearchForm').onsubmit = (e) => { e.preventDefault(); adminSearch(); };

  const acc = await initAuth(cfg);
  if (acc) await afterSignIn();
  else renderUser();
}

boot().catch((e) => toast(`Startup failed: ${e.message}`, true));
