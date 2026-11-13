// Removes everything azd down does NOT remove: SharePoint sites, demo users,
// Entra groups and app registrations. Run BEFORE `azd down --purge`:
//   node scripts/setup/cleanup.mjs [--yes] [--purge]
// --purge also empties the SharePoint site recycle bin and Entra "deleted items" for these objects, so the same
// site URLs, user names and app unique names can be reused right away by the next `azd up`.
import readline from 'node:readline/promises';
import { loadAzdEnv, log, env, sleep, HttpError } from './lib/util.mjs';
import { graph, spo } from './lib/clients.mjs';
import { SITES } from './steps/sharepoint.mjs';

loadAzdEnv();
const purge = process.argv.includes('--purge');

if (!process.argv.includes('--yes')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Delete${purge ? ' AND PERMANENTLY PURGE' : ''} the demo SharePoint sites, users, groups and app registrations? (yes/no) `);
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') process.exit(0);
}

const ignore404 = (p) => p.catch((e) => { if (!(e instanceof HttpError && e.status === 404)) throw e; });
const host = `https://${env('SHAREPOINT_HOSTNAME')}`;
const adminHost = host.replace('.sharepoint.com', '-admin.sharepoint.com');
const purgeDirectoryObject = async (id, label) => {
  if (!purge || !id) return;
  for (let i = 0; i < 10; i++) {
    try {
      await graph(`/directory/deletedItems/${id}`, { method: 'DELETE' });
      log.ok(`purged ${label}`);
      return;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404 && i < 9) { await sleep(3000); continue; } // not in deleted items yet
      log.warn(`purge ${label}: ${e.message.split('\n')[0]}`);
      return;
    }
  }
};

log.step('SharePoint sites');
for (const key of Object.keys(SITES)) {
  const url = env(`SITE_${key.toUpperCase()}_URL`);
  try {
    const u = new URL(url);
    const site = await graph(`/sites/${u.hostname}:${u.pathname}?$select=id`);
    const siteId = site.id.split(',')[1];
    await spo(host, 'SPSiteManager/delete', { method: 'POST', body: { siteId } });
    log.ok(`deleted ${url}${purge ? '' : ' (it stays in the SharePoint recycle bin for 93 days)'}`);
  } catch (e) {
    log.warn(`${url}: ${e.message.split('\n')[0]}`);
  }
  if (purge) {
    // Tenant admin API (SharePoint admin role): remove from the site recycle bin so the URL is free again.
    // RemoveDeletedSite returns 200 even when the site isn't there yet, so wait until it shows up first.
    const inBin = () => spo(adminHost, 'SPO.Tenant/GetDeletedSitePropertiesByUrl', { method: 'POST', body: { siteUrl: url } }).then(() => true, () => false);
    let found = false;
    for (let i = 0; i < 18 && !(found = await inBin()); i++) await sleep(10000);
    if (!found) { log.warn(`${url} not in the site recycle bin; nothing to purge`); continue; }
    await spo(adminHost, 'SPO.Tenant/RemoveDeletedSite', { method: 'POST', body: { siteUrl: url } });
    for (let i = 0; i < 18 && await inBin(); i++) await sleep(10000);
    log.ok(`purged ${url} from the site recycle bin`);
  }
}

log.step('Demo users');
for (const p of ['ALICE', 'BOB', 'CAROL']) {
  const id = process.env[`PERSONA_${p}_ID`];
  if (!id) continue;
  await ignore404(graph(`/users/${id}`, { method: 'DELETE' }));
  log.ok(`deleted ${env(`PERSONA_${p}_UPN`, id)}`);
  await purgeDirectoryObject(id, env(`PERSONA_${p}_UPN`, id));
}

log.step('Entra groups and app registrations');
for (const k of ['GROUP_ALL_STAFF_ID', 'GROUP_QUANTUM_ID', 'GROUP_DEMO_USERS_ID', 'GROUP_ADMINS_ID']) {
  const id = process.env[k];
  if (id) { await ignore404(graph(`/groups/${id}`, { method: 'DELETE' })); log.ok(`deleted group ${k}`); await purgeDirectoryObject(id, k); }
}
// The setup app is deleted last because this script authenticates with it.
for (const k of ['INGEST_APP_CLIENT_ID', 'WEB_APP_CLIENT_ID', 'SETUP_APP_CLIENT_ID']) {
  const appId = process.env[k];
  if (!appId) continue;
  const apps = (await graph(`/applications?$filter=appId eq '${appId}'&$select=id`)).value;
  for (const a of apps) {
    await graph(`/applications/${a.id}`, { method: 'DELETE' });
    log.ok(`deleted app ${k}`);
    await purgeDirectoryObject(a.id, `app ${k}`); // works for the setup app too: its access token predates the deletion
  }
  await sleep(500);
}
log.info('Now run: azd down --purge');
