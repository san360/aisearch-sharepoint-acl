import fs from 'node:fs';
import path from 'node:path';
import { graph, spo, siteUrl } from '../lib/clients.mjs';
import { env, log, sleep, http, HttpError } from '../lib/util.mjs';

const content = JSON.parse(fs.readFileSync(new URL('../content.json', import.meta.url), 'utf8'));
export const SITES = content.sites;

// ---------- Sites ----------
async function siteStatus(host, url) {
  const res = await spo(`https://${host}`, `SPSiteManager/status?url='${encodeURIComponent(url)}'`);
  return res.SiteStatus; // 0 not found, 1 provisioning, 2 ready, 3 error, 4 not found
}

async function ensureSite(key, def, adminUpn) {
  const host = env('SHAREPOINT_HOSTNAME');
  const url = siteUrl(key);
  let status = await siteStatus(host, url);
  if (status !== 2) {
    if (status !== 1) {
      const adminHost = `https://${host.replace('.sharepoint.com', '-admin.sharepoint.com')}`;
      const recycled = await spo(adminHost, 'SPO.Tenant/GetDeletedSitePropertiesByUrl', { method: 'POST', body: { siteUrl: url } }).then(() => true, () => false);
      if (recycled) {
        throw new Error(`${url} is in the SharePoint site recycle bin, so the URL can't be reused. Run `
          + '`node scripts/setup/cleanup.mjs --purge` (or delete it from SharePoint admin center → Deleted sites), '
          + 'or pick another prefix with `azd env set DEMO_PREFIX <name>`.');
      }
      log.info(`creating communication site ${url}`);
      await spo(`https://${host}`, 'SPSiteManager/create', {
        method: 'POST',
        body: {
          request: {
            Title: def.title,
            Url: url,
            Lcid: 1033,
            ShareByEmailEnabled: false,
            Description: def.description,
            WebTemplate: 'SITEPAGEPUBLISHING#0',
            Owner: adminUpn,
          },
        },
      });
    }
    for (let i = 0; i < 60 && status !== 2; i++) {
      await sleep(5000);
      status = await siteStatus(host, url);
    }
    if (status !== 2) throw new Error(`Site ${url} did not finish provisioning (status ${status})`);
    log.ok(`site ready: ${url}`);
  } else {
    log.info(`site exists: ${url}`);
  }
  const u = new URL(url);
  for (let i = 0; ; i++) {
    try {
      const site = await graph(`/sites/${u.hostname}:${u.pathname}?$select=id,webUrl,displayName`);
      const drive = await graph(`/sites/${site.id}/drive?$select=id,webUrl`);
      return { key, url, siteId: site.id, driveId: drive.id, driveWebUrl: drive.webUrl };
    } catch (e) {
      if (i > 12) throw e;
      await sleep(5000);
    }
  }
}

// ---------- Content ----------
const papersDir = path.resolve('data', 'papers');
const arxivHeaders = { 'User-Agent': 'aisearch-sharepoint-acl-demo (setup script)' };

export async function verifiedPaper(paper) {
  fs.mkdirSync(papersDir, { recursive: true });
  const file = path.join(papersDir, `${paper.id}.pdf`);
  const meta = path.join(papersDir, `${paper.id}.json`);
  if (fs.existsSync(file) && fs.existsSync(meta)) return { file, ...JSON.parse(fs.readFileSync(meta, 'utf8')) };
  const oai = await http(`https://export.arxiv.org/oai2?verb=GetRecord&identifier=oai:arXiv.org:${paper.id}&metadataPrefix=arXiv`, { headers: arxivHeaders });
  const license = /<license>([^<]+)<\/license>/.exec(oai)?.[1] ?? '';
  if (!/creativecommons\.org\/(licenses\/by(-sa)?\/|publicdomain\/zero)/.test(license)) {
    log.warn(`skipping arXiv:${paper.id} (licence '${license || 'none'}' is not CC BY / CC0)`);
    return null;
  }
  await sleep(3000); // arXiv asks for at most one request every 3 seconds
  const res = await http(`https://arxiv.org/pdf/${paper.id}`, { headers: arxivHeaders, raw: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  fs.writeFileSync(meta, JSON.stringify({ license }));
  await sleep(3000);
  return { file, license };
}

function safeName(s) {
  return s.replace(/[\\/:*?"<>|#%]/g, '').replace(/\s+/g, ' ').trim().slice(0, 110);
}

async function upload(site, folder, name, bytes) {
  const itemPath = `${folder}/${name}`.split('/').map(encodeURIComponent).join('/');
  const base = `/drives/${site.driveId}/root:/${itemPath}`;
  if (bytes.length <= 4 * 1024 * 1024) {
    return graph(`${base}:/content?@microsoft.graph.conflictBehavior=replace`, {
      method: 'PUT',
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }
  const session = await graph(`${base}:/createUploadSession`, {
    method: 'POST',
    body: { item: { '@microsoft.graph.conflictBehavior': 'replace' } },
  });
  const chunk = 327680 * 12;
  let result;
  for (let start = 0; start < bytes.length; start += chunk) {
    const end = Math.min(start + chunk, bytes.length);
    result = await http(session.uploadUrl, {
      method: 'PUT',
      body: bytes.subarray(start, end),
      headers: { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}`, 'Content-Type': 'application/octet-stream' },
    });
  }
  return result;
}

async function ensureFolder(site, folder) {
  try {
    return await graph(`/drives/${site.driveId}/root:/${encodeURIComponent(folder)}`);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 404) throw e;
    return graph(`/drives/${site.driveId}/root/children`, {
      method: 'POST',
      body: { name: folder, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
    });
  }
}

async function uploadContent(site, def) {
  for (const [folder, f] of Object.entries(def.folders)) {
    const item = await ensureFolder(site, folder);
    site.folders ??= {};
    site.folders[folder] = { webUrl: item.webUrl };
    const note = [
      `# Access note: ${def.title} / ${folder}`,
      '',
      `Codeword: ${f.codeword}`,
      '',
      `Who can see this folder: ${f.access}`,
      '',
      'This note exists so that searching for the codeword shows exactly which personas can see this folder.',
      '',
    ].join('\n');
    await upload(site, folder, `Access note - ${folder}.md`, Buffer.from(note, 'utf8'));
    for (const paper of f.papers) {
      const p = await verifiedPaper(paper);
      if (!p) continue;
      await upload(site, folder, `${safeName(paper.title)} (arXiv ${paper.id}).pdf`, fs.readFileSync(p.file));
    }
    log.ok(`${site.key}/${folder}: access note + ${f.papers.length} paper(s) uploaded`);
  }
}

// ---------- Permissions ----------
async function roleDefId(url, type) {
  // 2 = Reader, 3 = Contributor, 5 = Administrator (Full Control)
  return (await spo(url, `web/roledefinitions/getbytype(${type})?$select=Id`)).Id;
}

async function ensureUserId(url, logonName) {
  return (await spo(url, 'web/ensureuser', { method: 'POST', body: { logonName } })).Id;
}

const groupClaim = (id) => `c:0t.c|tenant|${id}`;
const userClaim = (upn) => `i:0#.f|membership|${upn}`;

function folderServerRelative(site, folder) {
  return decodeURIComponent(new URL(site.folders[folder].webUrl).pathname);
}

// Break inheritance on a web (subsite) or a list item (folder) and leave exactly: the site Owners group
// (Full Control) + the given principals (Read).
async function restrictScope(url, scope, principalLogonNames) {
  const unique = (await spo(url, `${scope}?$select=HasUniqueRoleAssignments`)).HasUniqueRoleAssignments;
  if (!unique) {
    await spo(url, `${scope}/breakroleinheritance(copyRoleAssignments=false,clearSubscopes=true)`, { method: 'POST' });
  }
  const reader = await roleDefId(url, 2);
  const admin = await roleDefId(url, 5);
  const owners = (await spo(url, 'web/associatedownergroup?$select=Id')).Id;
  await spo(url, `${scope}/roleassignments/addroleassignment(principalid=${owners},roledefid=${admin})`, { method: 'POST' });
  const ids = [];
  for (const logon of principalLogonNames) {
    const pid = await ensureUserId(url, logon);
    ids.push(pid);
    await spo(url, `${scope}/roleassignments/addroleassignment(principalid=${pid},roledefid=${reader})`, { method: 'POST' });
  }
  // Remove anything else left over from earlier runs (including the creator added by breakroleinheritance).
  const keep = new Set([owners, ...ids]);
  for (const ra of (await spo(url, `${scope}/roleassignments?$select=PrincipalId`)).value) {
    if (!keep.has(ra.PrincipalId)) {
      await spo(url, `${scope}/roleassignments/getbyprincipalid(${ra.PrincipalId})`, { method: 'POST', headers: { 'X-HTTP-Method': 'DELETE' } });
    }
  }
}

async function restrictFolder(site, folder, principalLogonNames) {
  const item = `web/GetFolderByServerRelativePath(decodedurl='${folderServerRelative(site, folder).replace(/'/g, "''")}')/ListItemAllFields`;
  await restrictScope(site.url, item, principalLogonNames);
}

// "access": { "groups": ["GROUP_..._ID"], "users": ["PERSONA_..._UPN"] } -> SharePoint claims
function principalsFrom(access = {}) {
  return [
    ...(access.groups ?? []).map((g) => groupClaim(env(g))),
    ...(access.users ?? []).map((u) => userClaim(env(u))),
  ];
}

async function grantWebRead(url, logonName) {
  const pid = await ensureUserId(url, logonName);
  const reader = await roleDefId(url, 2);
  await spo(url, `web/roleassignments/addroleassignment(principalid=${pid},roledefid=${reader})`, { method: 'POST' });
}

async function addToMembersGroup(url, upn) {
  const members = (await spo(url, 'web/associatedmembergroup?$select=Id')).Id;
  await spo(url, `web/sitegroups/getbyid(${members})/users`, { method: 'POST', body: { LoginName: userClaim(upn) } });
}

async function applyPermissions(sites) {
  const allStaff = groupClaim(env('GROUP_ALL_STAFF_ID'));
  const quantum = groupClaim(env('GROUP_QUANTUM_ID'));
  const carol = env('PERSONA_CAROL_UPN');
  const bob = env('PERSONA_BOB_UPN');

  // Research: All staff can read the site; Quantum and Bio folders are restricted.
  await grantWebRead(sites.research.url, allStaff);
  await restrictFolder(sites.research, 'Quantum', [quantum]);
  await restrictFolder(sites.research, 'Bio', [userClaim(carol)]);
  log.ok('research: All staff=Read on site, Quantum -> Quantum team group, Bio -> Carol (direct user)');

  // Finance: only the SharePoint "Members" site group, which contains Bob directly.
  await addToMembersGroup(sites.finance.url, bob);
  log.ok('finance: Bob added to the SharePoint site group "Members"');

  // HR: everyone can read it in SharePoint, but the ingestion app is never granted.
  await grantWebRead(sites.hr.url, allStaff);
  log.ok('hr: All staff=Read on site (never granted to the ingestion app)');

  // Subsites: unique permissions on the subsite (web), optionally a folder with its own unique permissions.
  for (const sub of Object.values(sites).filter((s) => s.parentKey)) {
    const def = SITES[sub.parentKey].subsites[sub.key];
    await restrictScope(sub.url, 'web', principalsFrom(def.access));
    for (const [folder, f] of Object.entries(def.folders)) {
      if (f.restrictTo) await restrictFolder(sub, folder, principalsFrom(f.restrictTo));
    }
    log.ok(`${sub.key} (subsite of ${sub.parentKey}): unique permissions on the subsite; ${Object.entries(def.folders)
      .map(([n, f]) => `${n} ${f.restrictTo ? 'unique' : 'inherits subsite'}`).join(', ')}`);
  }
}

// ---------- Subsites ----------
const SUBSITES_DISABLED = /New subsites are not available/i;

// Additional document library in a site (not the default "Documents" library).
async function ensureLibrary(site, name, def) {
  const lists = (await spo(site.url, `web/lists?$select=Title,BaseTemplate&$filter=Title eq '${name.replace(/'/g, "''")}'`)).value;
  if (!lists.length) {
    await spo(site.url, 'web/lists', { method: 'POST', body: { Title: name, Description: def.description, BaseTemplate: 101 } });
    log.ok(`${site.key}: document library '${name}' created`);
  }
  for (let i = 0; ; i++) {
    const drive = (await graph(`/sites/${site.siteId}/drives?$select=id,name,webUrl`)).value.find((d) => d.name === name);
    if (drive) return { ...site, key: `${site.key}/${name}`, driveId: drive.id, driveWebUrl: drive.webUrl, folders: undefined };
    if (i > 12) throw new Error(`library ${name} not visible in Graph`);
    await sleep(5000);
  }
}
async function ensureSubsite(parent, key, def) {
  const url = `${parent.url}/${def.url}`;
  const serverRelative = new URL(url).pathname.toLowerCase();
  const webs = (await spo(parent.url, 'web/webs?$select=ServerRelativeUrl')).value;
  if (!webs.some((w) => w.ServerRelativeUrl.toLowerCase() === serverRelative)) {
    log.info(`creating subsite ${url}`);
    await spo(parent.url, 'web/webs/add', {
      method: 'POST',
      body: {
        parameters: {
          Title: def.title,
          Url: def.url,
          Description: def.description,
          Language: 1033,
          WebTemplate: 'STS#3',
          UseSamePermissionsAsParentSite: true,
        },
      },
    });
    log.ok(`subsite ready: ${url}`);
  } else {
    log.info(`subsite exists: ${url}`);
  }
  const u = new URL(url);
  for (let i = 0; ; i++) {
    try {
      const site = await graph(`/sites/${u.hostname}:${u.pathname}?$select=id,webUrl,displayName`);
      const drive = await graph(`/sites/${site.id}/drive?$select=id,webUrl`);
      return { key, url, parentKey: parent.key, siteId: site.id, driveId: drive.id, driveWebUrl: drive.webUrl };
    } catch (e) {
      if (i > 12) throw e;
      await sleep(5000);
    }
  }
}

// Azure AI Search resolves SharePoint site groups (spg:) at query time by looking the signed-in user up in
// every indexed site's User Information List. If the user isn't listed on one of those sites (typical when access
// comes only through an Entra group and the user never opened the site) the whole query fails with
// "siteusers/getbyemail ... 404 User cannot be found" (preview behaviour). Registering users with ensureuser
// adds them to the list without granting anything.
export async function registerSiteUsers(sites) {
  const upns = ['ALICE', 'BOB', 'CAROL'].map((p) => env(`PERSONA_${p}_UPN`)).filter(Boolean);
  for (const [key, def] of Object.entries(SITES)) {
    if (!def.granted) continue;
    for (const upn of upns) await ensureUserId(sites[key].url, userClaim(upn));
    log.ok(`${key}: ${upns.length} persona(s) registered in the site's user list (no permissions granted)`);
  }
}

// ---------- Sites.Selected grants ----------
async function applySiteGrants(sites) {
  const appId = env('INGEST_APP_CLIENT_ID');
  const displayName = env('INGEST_APP_DISPLAY_NAME', 'SharePoint ingestion');
  const role = env('SITE_GRANT_ROLE', 'read');
  for (const [key, def] of Object.entries(SITES)) {
    const site = sites[key];
    const perms = (await graph(`/sites/${site.siteId}/permissions`)).value ?? [];
    const existing = perms.filter((p) =>
      [...(p.grantedToIdentitiesV2 ?? []), ...(p.grantedToIdentities ?? [])].some((g) => g.application?.id === appId));
    if (def.granted) {
      if (existing.length && existing.every((p) => p.roles?.includes(role))) {
        log.info(`${key}: ingestion app already granted '${role}'`);
        continue;
      }
      for (const p of existing) await graph(`/sites/${site.siteId}/permissions/${p.id}`, { method: 'DELETE' });
      await graph(`/sites/${site.siteId}/permissions`, {
        method: 'POST',
        body: { roles: [role], grantedToIdentities: [{ application: { id: appId, displayName } }] },
      });
      log.ok(`${key}: Sites.Selected grant '${role}' -> ingestion app`);
    } else {
      for (const p of existing) await graph(`/sites/${site.siteId}/permissions/${p.id}`, { method: 'DELETE' });
      log.ok(`${key}: NO grant for the ingestion app (proof site)`);
    }
  }
}

export async function setupSharePoint() {
  log.step('SharePoint sites');
  const me = await graph('/me?$select=userPrincipalName');
  const sites = {};
  for (const [key, def] of Object.entries(SITES)) {
    sites[key] = await ensureSite(key, def, me.userPrincipalName);
  }
  for (const [parentKey, def] of Object.entries(SITES)) {
    for (const [key, sub] of Object.entries(def.subsites ?? {})) {
      try {
        sites[key] = await ensureSubsite(sites[parentKey], key, sub);
      } catch (e) {
        if (!SUBSITES_DISABLED.test(String(e.body?.['odata.error']?.message?.value ?? e.message))) throw e;
        log.warn(`subsite '${key}' skipped: subsite creation is disabled for this tenant.\n`
          + '      Enable it once (UI only, no API): SharePoint admin center -> Settings -> "classic settings page" ->\n'
          + '      Subsite Creation -> "Enable subsite creation for all sites" -> OK. Then re-run:\n'
          + '      node scripts/setup/index.mjs --only sharepoint && node scripts/setup/index.mjs --only search');
      }
    }
  }

  log.step('Sample content (CC BY arXiv papers + access notes)');
  for (const [key, def] of Object.entries(SITES)) {
    await uploadContent(sites[key], def);
    for (const [lib, ld] of Object.entries(def.libraries ?? {})) await uploadContent(await ensureLibrary(sites[key], lib, ld), ld);
    for (const [subKey, sub] of Object.entries(def.subsites ?? {})) if (sites[subKey]) await uploadContent(sites[subKey], sub);
  }

  log.step('SharePoint permissions');
  await applyPermissions(sites);
  await registerSiteUsers(sites);

  log.step('Sites.Selected grants (least privilege)');
  await applySiteGrants(sites);
  return sites;
}
