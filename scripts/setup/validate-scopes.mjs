// Validates which items each SharePoint data source "container" setting indexes.
// For every scenario: scratch data source + index + indexer (metadata only, no skills, no ACLs),
// wait for the run, list the indexed item paths, then delete the scratch objects.
//
//   node scripts/setup/validate-scopes.mjs            # all scenarios
//   node scripts/setup/validate-scopes.mjs S1 S4      # selected scenarios
//
// Results are printed and written to .azure/<env>/scope-validation.json (local only).
import fs from 'node:fs';
import path from 'node:path';
import { loadAzdEnv, env, log, sleep } from './lib/util.mjs';

loadAzdEnv();
const { search } = await import('./steps/search.mjs');

const research = env('SITE_RESEARCH_URL');
const host = new URL(research).host;
const docs = `${research}/Shared Documents`;
const subsite = `${research}/llmlab`;

export const SCENARIOS = [
  { id: 'S1', label: 'defaultSiteLibrary', container: { name: 'defaultSiteLibrary', query: null } },
  { id: 'S2', label: 'allSiteLibraries', container: { name: 'allSiteLibraries', query: null } },
  { id: 'S3', label: 'allSiteLibraries + includeSubsites=true', container: { name: 'allSiteLibraries', query: 'includeSubsites=true' } },
  { id: 'S4', label: 'useQuery includeLibrary (Archive only)', container: { name: 'useQuery', query: `includeLibrary=${research}/Archive` } },
  { id: 'S5', label: 'useQuery includeLibrariesInSite + excludeLibrary (Archive)', container: { name: 'useQuery', query: `includeLibrariesInSite=${research};excludeLibrary=${research}/Archive` } },
  { id: 'S6', label: 'useQuery includeFolder (Quantum)', container: { name: 'useQuery', query: `includeFolder=${docs}/Quantum` } },
  { id: 'S7', label: 'useQuery includeFolder x2 (Public, Bio)', container: { name: 'useQuery', query: `includeFolder=${docs}/Public;includeFolder=${docs}/Bio` } },
  { id: 'S8', label: 'useQuery includeLibrary (Documents) + excludeFolder (Quantum)', container: { name: 'useQuery', query: `includeLibrary=${docs};excludeFolder=${docs}/Quantum` } },
  { id: 'S9', label: 'useQuery includeLibrariesInSite (subsite only)', container: { name: 'useQuery', query: `includeLibrariesInSite=${subsite}` } },
  { id: 'S10', label: 'useQuery with a KQL expression', container: { name: 'useQuery', query: `Path:"https://${host}/sites/${new URL(research).pathname.split('/').pop()}/Shared Documents/Quantum"` } },
];

const want = process.argv.slice(2);
const selected = SCENARIOS.filter((s) => !want.length || want.includes(s.id));
const suffix = 'scn';

function dataSource(name, container) {
  return {
    name,
    type: 'sharepoint',
    credentials: {
      connectionString: `SharePointOnlineEndpoint=${research};ApplicationId=${env('INGEST_APP_CLIENT_ID')};FederatedCredentialApplicationId=${env('SEARCH_IDENTITY_CLIENT_ID')};TenantId=${env('AZURE_TENANT_ID')}`,
    },
    container,
    identity: { '@odata.type': '#Microsoft.Azure.Search.DataUserAssignedIdentity', userAssignedIdentity: env('SEARCH_IDENTITY_RESOURCE_ID') },
  };
}

const index = (name) => ({
  name,
  fields: [
    { name: 'id', type: 'Edm.String', key: true },
    { name: 'metadata_spo_item_path', type: 'Edm.String', searchable: true, retrievable: true },
    { name: 'metadata_spo_item_name', type: 'Edm.String', retrievable: true },
  ],
});

const indexer = (name) => ({
  name,
  dataSourceName: name,
  targetIndexName: name,
  parameters: {
    configuration: {
      dataToExtract: 'storageMetadata',
      indexedFileNameExtensions: '.pdf,.docx,.pptx,.md,.txt',
    },
  },
  fieldMappings: [{ sourceFieldName: 'metadata_spo_site_library_item_id', targetFieldName: 'id', mappingFunction: { name: 'base64Encode' } }],
});

async function drop(name) {
  for (const kind of ['indexers', 'datasources', 'indexes']) {
    await search(`${kind}('${name}')`, { method: 'DELETE' }).catch(() => {});
  }
}

const libraries = new Map();
async function loadLibraries() {
  const { graph } = await import('./lib/clients.mjs');
  for (const url of [research, subsite]) {
    const u = new URL(url);
    try {
      const site = await graph(`/sites/${u.hostname}:${u.pathname}?$select=id`);
      for (const d of (await graph(`/sites/${site.id}/drives?$select=id,name`)).value) {
        libraries.set(d.id, `${url === subsite ? 'llmlab/' : ''}${d.name}`);
      }
    } catch { /* subsite may not exist */ }
  }
}

function shortPath(p) {
  // "/drives/<drive id>/root:/Folder/file" -> "<library>/Folder/file"
  const m = /^\/drives\/([^/]+)\/root:\/(.*)$/.exec(p);
  return m ? `${libraries.get(m[1]) ?? m[1].slice(0, 8)}/${decodeURIComponent(m[2])}` : p;
}

async function runScenario(s) {
  const name = `${suffix}-${s.id.toLowerCase()}`;
  await drop(name);
  const result = { ...s };
  try {
    await search(`datasources('${name}')`, { method: 'PUT', body: dataSource(name, s.container) });
    await search(`indexes('${name}')`, { method: 'PUT', body: index(name) });
    await search(`indexers('${name}')`, { method: 'PUT', body: indexer(name) });
  } catch (e) {
    result.outcome = 'rejected';
    result.error = String(e.body?.error?.message ?? e.message).split('\n')[0].slice(0, 300);
    await drop(name);
    return result;
  }
  const deadline = Date.now() + 10 * 60_000;
  let st;
  while (Date.now() < deadline) {
    await sleep(10000);
    st = await search(`indexers('${name}')/search.status`);
    const last = st.lastResult;
    if (last && !['inProgress', 'reset'].includes(last.status) && last.endTime) break;
  }
  const last = st?.lastResult ?? {};
  result.outcome = last.status ?? 'timeout';
  result.itemsProcessed = last.itemsProcessed ?? 0;
  result.itemsFailed = last.itemsFailed ?? 0;
  if (last.errorMessage) result.error = last.errorMessage.slice(0, 300);
  await sleep(3000);
  const docsFound = await search(`indexes('${name}')/docs/search.post.search`, {
    method: 'POST',
    body: { search: '*', top: 1000, select: 'metadata_spo_item_path,metadata_spo_item_name' },
  }).catch(() => ({ value: [] }));
  result.items = docsFound.value.map((d) => d.metadata_spo_item_path).filter(Boolean).map(shortPath).sort();
  await drop(name);
  return result;
}

const results = [];
await loadLibraries();
for (const s of selected) {
  log.step(`${s.id} ${s.label}`);
  log.info(`container: ${JSON.stringify(s.container)}`);
  const r = await runScenario(s);
  results.push(r);
  const line = `${r.outcome}${r.items ? `, ${r.items.length} item(s)` : ''}${r.error ? ` - ${r.error}` : ''}`;
  r.outcome === 'success' ? log.ok(line) : log.warn(line);
  for (const it of r.items ?? []) console.log(`      ${it}`);
}

const out = path.resolve('.azure', env('AZURE_ENV_NAME', 'local'), 'scope-validation.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
log.ok(`results written to ${path.relative(process.cwd(), out)}`);
