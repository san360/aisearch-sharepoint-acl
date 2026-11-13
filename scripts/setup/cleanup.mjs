// Removes everything azd down does NOT remove: SharePoint sites, demo users,
// Entra groups and app registrations. Run BEFORE `azd down --purge`:
//   node scripts/setup/cleanup.mjs [--yes]
import readline from 'node:readline/promises';
import { loadAzdEnv, log, env, sleep, HttpError } from './lib/util.mjs';
import { graph, spo } from './lib/clients.mjs';
import { SITES } from './steps/sharepoint.mjs';

loadAzdEnv();

if (!process.argv.includes('--yes')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Delete the demo SharePoint sites, users, groups and app registrations? (yes/no) ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') process.exit(0);
}

const ignore404 = (p) => p.catch((e) => { if (!(e instanceof HttpError && e.status === 404)) throw e; });
const host = `https://${env('SHAREPOINT_HOSTNAME')}`;

log.step('SharePoint sites');
for (const key of Object.keys(SITES)) {
  const url = env(`SITE_${key.toUpperCase()}_URL`);
  try {
    const u = new URL(url);
    const site = await graph(`/sites/${u.hostname}:${u.pathname}?$select=id`);
    const siteId = site.id.split(',')[1];
    await spo(host, 'SPSiteManager/delete', { method: 'POST', body: { siteId } });
    log.ok(`deleted ${url} (it stays in the SharePoint recycle bin for 93 days)`);
  } catch (e) {
    log.warn(`${url}: ${e.message.split('\n')[0]}`);
  }
}

log.step('Demo users');
for (const p of ['ALICE', 'BOB', 'CAROL']) {
  const id = process.env[`PERSONA_${p}_ID`];
  if (!id) continue;
  await ignore404(graph(`/users/${id}`, { method: 'DELETE' }));
  log.ok(`deleted ${env(`PERSONA_${p}_UPN`, id)}`);
}

log.step('Entra groups and app registrations');
for (const k of ['GROUP_ALL_STAFF_ID', 'GROUP_QUANTUM_ID', 'GROUP_DEMO_USERS_ID', 'GROUP_ADMINS_ID']) {
  const id = process.env[k];
  if (id) { await ignore404(graph(`/groups/${id}`, { method: 'DELETE' })); log.ok(`deleted group ${k}`); }
}
// The setup app is deleted last because this script authenticates with it.
for (const k of ['INGEST_APP_CLIENT_ID', 'WEB_APP_CLIENT_ID', 'SETUP_APP_CLIENT_ID']) {
  const appId = process.env[k];
  if (!appId) continue;
  const apps = (await graph(`/applications?$filter=appId eq '${appId}'&$select=id`)).value;
  for (const a of apps) { await graph(`/applications/${a.id}`, { method: 'DELETE' }); log.ok(`deleted app ${k}`); }
  await sleep(500);
}
log.info('Now run: azd down --purge');
