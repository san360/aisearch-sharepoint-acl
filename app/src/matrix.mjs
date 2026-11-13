import { config, collections } from './config.mjs';
import { ingestCredential } from './credentials.mjs';
import { searchAsUser } from './search.mjs';
import { groupMembers, userGroups, resolvePrincipals } from './graph.mjs';

// One column per access note; the codeword only appears in that note.
export const COLUMNS = [
  { codeword: 'BLUEBIRD', site: 'research', folder: 'Public' },
  { codeword: 'AURORA', site: 'research', folder: 'Quantum' },
  { codeword: 'KESTREL', site: 'research', folder: 'Bio' },
  { codeword: 'WREN', site: 'research', folder: 'Notes', library: 'Archive' },
  { codeword: 'HERON', site: 'llmlab', folder: 'Papers' },
  { codeword: 'MAGPIE', site: 'llmlab', folder: 'Drafts' },
  { codeword: 'NIGHTJAR', site: 'finance', folder: 'Reports' },
  { codeword: 'OSPREY', site: 'hr', folder: 'Confidential' },
];

const normUrl = (u) => String(u ?? '').toLowerCase().replace(/\/+$/, '');

// Subsites only exist once subsite creation is enabled for the tenant. Checked as the ingestion app
// (its Sites.Selected grant on the site collection covers subsites); cached for 5 minutes.
let subsiteCache = { at: 0, value: {} };
export async function subsitesAvailable() {
  if (Date.now() - subsiteCache.at < 300_000) return subsiteCache.value;
  const value = {};
  const cred = ingestCredential();
  const token = cred ? (await cred.getToken('https://graph.microsoft.com/.default').catch(() => null))?.token : null;
  await Promise.all(config.sites.filter((s) => s.parent && s.url).map(async (s) => {
    if (!token) { value[s.key] = null; return; }
    const u = new URL(s.url);
    const res = await fetch(`https://graph.microsoft.com/v1.0/sites/${u.hostname}:${u.pathname}?$select=id,webUrl`, { headers: { Authorization: `Bearer ${token}` } });
    // Graph resolves a missing subsite path to the parent site, so compare the returned URL.
    value[s.key] = res.ok && normUrl((await res.json()).webUrl) === normUrl(s.url);
  }));
  subsiteCache = { at: Date.now(), value };
  return value;
}

// The same call Azure AI Search makes to expand SharePoint site groups (spg:) at query time,
// made here as the ingestion app (Sites.Selected, federated credential).
async function spGroupsOnSite(token, site, upn) {
  const res = await fetch(`${site.url}/_api/web/siteusers/getbyemail('${encodeURIComponent(upn)}')/groups?$select=Id,Title`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json;odata=nometadata' },
  });
  if (res.status === 404) return { missing: true, groups: new Map() };
  if (!res.ok) throw new Error(`SharePoint ${res.status} on ${site.name}`);
  return { missing: false, groups: new Map((await res.json()).value.map((g) => [g.Id, g.Title])) };
}

async function principalContext(user, spToken, indexedSites) {
  const groups = await userGroups(user.id);
  const ctx = { ...user, groups: new Map(groups.map((g) => [g.id, g.name])), sp: new Map(), notInSiteList: [], warnings: [] };
  await Promise.all(indexedSites.map(async (site) => {
    if (!spToken) return;
    try {
      const r = await spGroupsOnSite(spToken, site, user.upn);
      ctx.sp.set(normUrl(site.url), r.groups);
      if (r.missing) ctx.notInSiteList.push(site.name);
    } catch (e) {
      ctx.warnings.push(e.message);
    }
  }));
  return ctx;
}

function evaluate(acl, who) {
  if (acl.userIds.includes(who.id)) return { via: 'user', label: 'direct permission' };
  for (const id of acl.groupIds) {
    if (who.groups.has(id)) return { via: 'entra-group', label: who.groups.get(id) };
    const m = /^spg:(.+):(\d+)$/.exec(id);
    // SharePoint groups belong to the site collection; a subsite's spg: id may carry the subsite URL.
    const key = m && [...who.sp.keys()].find((k) => normUrl(m[1]) === k || normUrl(m[1]).startsWith(`${k}/`));
    const title = key && who.sp.get(key)?.get(Number(m[2]));
    if (title) return { via: 'sp-group', label: title };
  }
  return null;
}

// Personas (demo users group) with their transitive Entra groups and, for sites the ingestion app may read,
// their SharePoint site groups. Sites without a grant report null (membership can't be read).
export async function peopleAccessContext() {
  const indexedSites = collections().filter((s) => s.granted && s.url);
  let spToken = null;
  try {
    spToken = (await ingestCredential()?.getToken(`https://${config.sharePointHost}/.default`))?.token ?? null;
  } catch { /* site groups stay unknown */ }
  const people = (await groupMembers(config.groups.demoUsers)).sort((a, b) => a.upn.localeCompare(b.upn));
  return Promise.all(people.map(async (p) => {
    const ctx = await principalContext(p, spToken, indexedSites);
    return {
      id: p.id,
      upn: p.upn,
      displayName: p.displayName,
      groups: [...ctx.groups].map(([id, name]) => ({ id, name })),
      spGroups: Object.fromEntries(config.sites.map((s) => {
        const m = ctx.sp.get(normUrl(s.url));
        return [s.key, m ? [...m.values()] : null];
      })),
    };
  }));
}

export async function liveMatrix(user, { admin = false } = {}) {
  const started = Date.now();
  const sites = new Map(config.sites.map((s) => [s.key, s]));
  const indexedSites = collections().filter((s) => s.granted && s.url);

  // Ground truth for the signed-in user: the real ACL-trimmed query with their own token.
  const [mine, subsites] = await Promise.all([
    Promise.all(COLUMNS.map((c) =>
      searchAsUser(user.token, { q: `"${c.codeword}"`, mode: 'keyword', top: 1 })
        .then((r) => r.count > 0).catch((e) => ({ error: e.message })))),
    subsitesAvailable().catch(() => ({})),
  ]);
  const available = (c) => subsites[c.site] !== false;

  // Reading the stored ACLs needs elevated read, which only admins have. Everyone else gets their own live row.
  if (!admin) {
    return {
      scope: 'self',
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - started,
      columns: COLUMNS.map((c) => ({ ...c, siteName: sites.get(c.site)?.name ?? c.site, granted: sites.get(c.site)?.granted ?? false, available: available(c) })),
      rows: [{
        id: user.oid, upn: user.upn, displayName: user.name, me: true, notInSiteList: [], warnings: [],
        cells: mine.map((v) => ({ access: v === true, verified: v })),
      }],
    };
  }

  let spToken = null;
  let spError = null;
  try {
    spToken = (await ingestCredential()?.getToken(`https://${config.sharePointHost}/.default`))?.token ?? null;
    if (!spToken) spError = 'SharePoint site groups can only be resolved in Azure (federated credential).';
  } catch (e) {
    spError = e.message;
  }

  // 1. What is actually in the index for each codeword, with the stored ACL (elevated read, no trimming).
  const columns = await Promise.all(COLUMNS.map(async (c) => {
    const data = await searchAsUser(user.token, { q: `"${c.codeword}"`, mode: 'keyword', top: 10, elevated: true, withAcl: true });
    const acl = {
      userIds: [...new Set(data.results.flatMap((r) => r.userIds))],
      groupIds: [...new Set(data.results.flatMap((r) => r.groupIds))],
    };
    return {
      ...c,
      siteName: sites.get(c.site)?.name ?? c.site,
      granted: sites.get(c.site)?.granted ?? false,
      available: available(c),
      indexed: data.results.length > 0,
      document: data.results[0]?.title ?? null,
      acl,
    };
  }));
  const names = await resolvePrincipals(columns.flatMap((c) => [...c.acl.userIds, ...c.acl.groupIds]));

  // 2. Who: the demo personas plus the signed-in user.
  const people = (await groupMembers(config.groups.demoUsers).catch(() => []))
    .sort((a, b) => a.upn.localeCompare(b.upn));
  if (!people.some((p) => p.id === user.oid)) people.push({ id: user.oid, upn: user.upn, displayName: user.name });
  const contexts = await Promise.all(people.map((p) => principalContext(p, spToken, indexedSites)));

  const rows = contexts.map((who) => ({
    id: who.id,
    upn: who.upn,
    displayName: who.displayName,
    me: who.id === user.oid,
    notInSiteList: who.notInSiteList,
    warnings: who.warnings,
    cells: columns.map((c, i) => {
      const hit = c.indexed ? evaluate(c.acl, who) : null;
      const cell = { access: Boolean(hit), via: hit?.via ?? null, label: hit?.label ?? null };
      if (who.id === user.oid) cell.verified = mine[i];
      return cell;
    }),
  }));

  return {
    scope: 'all',
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - started,
    spError,
    columns: columns.map(({ acl, ...c }) => ({
      ...c,
      principals: [...acl.userIds, ...acl.groupIds].map((id) => names[id]?.name ?? id),
    })),
    rows,
  };
}
