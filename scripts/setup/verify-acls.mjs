// Index integrity check: is the security-relevant configuration intact, and do the ACLs stored in the index still
// match SharePoint? Detects tampering such as a document merged with UserIds ["all"], injected documents, a disabled
// permission filter, or a pipeline that no longer maps SharePoint permissions.
//
//   node scripts/setup/verify-acls.mjs            # config checks + ACL comparison against a fresh shadow crawl
//   node scripts/setup/verify-acls.mjs --config   # config checks only (fast, nothing created)
//   node scripts/setup/verify-acls.mjs --fix      # on ACL drift: resync permissions + run the affected indexers
//
// The ACL comparison creates temporary objects (vfy-*): a metadata-only data source + indexer per indexed site and a
// small index that receives SharePoint's current ACLs. They are deleted afterwards. Exit code 1 when anything is found.
// Needs the deploying admin's roles (Search Service Contributor + Search Index Data Contributor for elevated read).
import fs from 'node:fs';
import path from 'node:path';
import { loadAzdEnv, env, log, sleep } from './lib/util.mjs';

loadAzdEnv();
const { search } = await import('./steps/search.mjs');
const content = JSON.parse(fs.readFileSync(new URL('./content.json', import.meta.url), 'utf8'));

const INDEX = env('SEARCH_INDEX_NAME', 'sharepoint-acl-index');
const SKILLSET = 'sharepoint-acl-skillset';
const SITES = Object.entries(content.sites).filter(([, s]) => s.granted).map(([key]) => key);
const configOnly = process.argv.includes('--config');
const fix = process.argv.includes('--fix');
const findings = [];
const finding = (area, msg) => { findings.push({ area, msg }); log.warn(`${area}: ${msg}`); };

// ---------- 1. Configuration ----------
log.step('Security-relevant configuration');
const index = await search(`indexes('${INDEX}')`);
if (index.permissionFilterOption !== 'enabled') finding('index', `permissionFilterOption is '${index.permissionFilterOption}' — ACL trimming is OFF for every query`);
const pf = Object.fromEntries(index.fields.filter((f) => f.permissionFilter).map((f) => [f.permissionFilter, f.name]));
if (pf.userIds !== 'UserIds' || pf.groupIds !== 'GroupIds') finding('index', `permission filter fields changed: ${JSON.stringify(pf)}`);
if (!index.sharePointConnectorAppRegistration?.applicationId) finding('index', 'sharePointConnectorAppRegistration missing — SharePoint group (spg:) access no longer resolves');
else if (index.sharePointConnectorAppRegistration.applicationId !== env('INGEST_APP_CLIENT_ID')) finding('index', 'sharePointConnectorAppRegistration points to a different app');

const skillset = await search(`skillsets('${SKILLSET}')`);
const maps = Object.fromEntries((skillset.indexProjections?.selectors ?? []).flatMap((s) => s.mappings).map((m) => [m.name, m.source ?? m.sourceContext ?? 'inputs']));
if (maps.UserIds !== '/document/metadata_user_ids') finding('skillset', `UserIds is projected from '${maps.UserIds}', not /document/metadata_user_ids`);
if (maps.GroupIds !== '/document/metadata_group_ids') finding('skillset', `GroupIds is projected from '${maps.GroupIds}', not /document/metadata_group_ids`);
const expectedSkills = ['#Microsoft.Skills.Text.SplitSkill', '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill'];
for (const s of skillset.skills) if (!expectedSkills.includes(s['@odata.type'])) finding('skillset', `unexpected skill ${s['@odata.type']} '${s.name}' — it could rewrite permission metadata`);

const datasources = {};
for (const key of SITES) {
  const ds = await search(`datasources('ds-${key}')`).catch(() => null);
  if (!ds) { finding('data source', `ds-${key} missing`); continue; }
  datasources[key] = ds;
  const opts = ds.indexerPermissionOptions ?? [];
  if (!opts.includes('userIds') || !opts.includes('groupIds')) finding('data source', `ds-${key} indexerPermissionOptions = ${JSON.stringify(opts)} — ACLs are no longer ingested`);
  const ixr = await search(`indexers('ixr-${key}')`).catch(() => null);
  if (!ixr) { finding('indexer', `ixr-${key} missing`); continue; }
  for (const m of [...(ixr.fieldMappings ?? []), ...(ixr.outputFieldMappings ?? [])]) {
    if (['UserIds', 'GroupIds', 'SharePointSiteUrl'].includes(m.targetFieldName)) finding('indexer', `ixr-${key} maps '${m.sourceFieldName}' onto ${m.targetFieldName}`);
  }
  if (ixr.skillsetName !== SKILLSET || ixr.targetIndexName !== INDEX) finding('indexer', `ixr-${key} uses skillset '${ixr.skillsetName}' / index '${ixr.targetIndexName}'`);
}
if (!findings.length) log.ok('index, skillset, data sources and indexers: permission settings intact');
if (configOnly) process.exit(findings.length ? 1 : 0);

// ---------- 2. What the index holds ----------
log.step('ACLs stored in the index (elevated read)');
const live = [];
for (let skip = 0; ; skip += 1000) {
  const page = await search(`indexes('${INDEX}')/docs/search.post.search`, {
    method: 'POST',
    headers: { 'x-ms-enable-elevated-read': 'true' },
    body: { search: '*', top: 1000, skip, select: 'chunk_id,title,metadata_spo_item_path,SharePointSiteUrl,UserIds,GroupIds' },
  });
  live.push(...page.value);
  if (page.value.length < 1000) break;
}
log.info(`${live.length} chunk(s)`);
for (const d of live) {
  for (const f of ['UserIds', 'GroupIds']) {
    const special = (d[f] ?? []).filter((x) => ['all', 'none'].includes(String(x).toLowerCase()));
    if (special.length) finding('acl', `${d.title} (${d.chunk_id.slice(-12)}): ${f} contains ${JSON.stringify(special)}${special.includes('all') ? ' — readable by EVERY user' : ''}`);
  }
}

// ---------- 3. What SharePoint says now (shadow crawl) ----------
log.step('Current SharePoint ACLs (temporary metadata-only crawl)');
const shadow = 'vfy-acls';
const drop = async (kind, name) => search(`${kind}('${name}')`, { method: 'DELETE' }).catch(() => {});
await drop('indexes', shadow);
await search(`indexes('${shadow}')`, {
  method: 'PUT',
  body: {
    name: shadow,
    fields: [
      { name: 'id', type: 'Edm.String', key: true },
      { name: 'metadata_spo_item_path', type: 'Edm.String', retrievable: true }, // required name for ACL ingestion
      { name: 'UserIds', type: 'Collection(Edm.String)', retrievable: true },
      { name: 'GroupIds', type: 'Collection(Edm.String)', retrievable: true },
    ],
  },
});
const source = new Map();
try {
  for (const key of Object.keys(datasources)) {
    const name = `vfy-${key}`;
    const live = datasources[key];
    await drop('indexers', name);
    // GET redacts the connection string, so it's rebuilt; the container (scope) is taken from the live data source.
    await search(`datasources('${name}')`, {
      method: 'PUT',
      body: {
        name,
        type: 'sharepoint',
        indexerPermissionOptions: ['userIds', 'groupIds'],
        credentials: { connectionString: `SharePointOnlineEndpoint=${env(`SITE_${key.toUpperCase()}_URL`)};ApplicationId=${env('INGEST_APP_CLIENT_ID')};FederatedCredentialApplicationId=${env('SEARCH_IDENTITY_CLIENT_ID')};TenantId=${env('AZURE_TENANT_ID')}` },
        container: live.container,
        identity: live.identity,
      },
    });
    await search(`indexers('${name}')`, {
      method: 'PUT',
      body: {
        name,
        dataSourceName: name,
        targetIndexName: shadow,
        parameters: { configuration: { dataToExtract: 'storageMetadata', indexedFileNameExtensions: '.pdf,.docx,.pptx,.md,.txt' } },
        fieldMappings: [
          { sourceFieldName: 'metadata_spo_site_library_item_id', targetFieldName: 'id', mappingFunction: { name: 'base64Encode' } },
          { sourceFieldName: 'metadata_user_ids', targetFieldName: 'UserIds' },
          { sourceFieldName: 'metadata_group_ids', targetFieldName: 'GroupIds' },
        ],
      },
    });
    let st;
    for (let i = 0; i < 60; i++) {
      await sleep(10000);
      st = (await search(`indexers('${name}')/search.status`)).lastResult;
      if (st && st.status !== 'inProgress' && st.endTime) break;
    }
    if (st?.status !== 'success') finding('shadow', `${name}: ${st?.status ?? 'timeout'} ${st?.errorMessage ?? ''}`);
    else log.ok(`${key}: ${st.itemsProcessed} item(s) crawled`);
  }
  await sleep(3000);
  const rows = await search(`indexes('${shadow}')/docs/search.post.search`, { method: 'POST', body: { search: '*', top: 1000, select: 'metadata_spo_item_path,UserIds,GroupIds' } });
  for (const r of rows.value) source.set(r.metadata_spo_item_path, r);
} finally {
  for (const key of Object.keys(datasources)) { await drop('indexers', `vfy-${key}`); await drop('datasources', `vfy-${key}`); }
  await drop('indexes', shadow);
}

// ---------- 4. Compare ----------
log.step('Index vs SharePoint');
const norm = (a) => JSON.stringify([...(a ?? [])].map(String).sort());
const drifted = new Set();
let checked = 0;
for (const d of live) {
  const src = source.get(d.metadata_spo_item_path);
  if (!src) { finding('orphan', `${d.title} (${d.metadata_spo_item_path}) is in the index but not in SharePoint — injected or stale`); continue; }
  checked++;
  for (const f of ['UserIds', 'GroupIds']) {
    if (norm(d[f]) !== norm(src[f])) {
      finding('acl drift', `${d.title}: ${f} index=${norm(d[f])} SharePoint=${norm(src[f])}`);
      drifted.add(Object.keys(datasources).find((k) => d.SharePointSiteUrl?.toLowerCase() === env(`SITE_${k.toUpperCase()}_URL`).toLowerCase()) ?? '?');
    }
  }
}
const indexedPaths = new Set(live.map((d) => d.metadata_spo_item_path));
const missing = [...source.keys()].filter((p) => !indexedPaths.has(p));
if (missing.length) log.info(`${missing.length} SharePoint item(s) not indexed yet (new since the last run, or no extractable text)`);
log.info(`${checked} chunk(s) compared with SharePoint's current permissions`);

if (fix && drifted.size) {
  log.step('Repair: resync permissions + run');
  for (const key of drifted) {
    if (key === '?') continue;
    await search(`indexers('ixr-${key}')/search.resync`, { method: 'POST', body: { options: ['permissions'] } });
    await search(`indexers('ixr-${key}')/search.run`, { method: 'POST' });
    log.ok(`ixr-${key}: resync started — re-run this check after the run completes`);
  }
}

const out = path.resolve('.azure', env('AZURE_ENV_NAME', 'local'), 'acl-verification.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), chunks: live.length, compared: checked, findings }, null, 2));
if (findings.length) { log.warn(`${findings.length} finding(s) — details in ${path.relative(process.cwd(), out)}`); process.exit(1); }
log.ok('no tampering or drift found');
