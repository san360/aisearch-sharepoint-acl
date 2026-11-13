// preprovision hook: validate the region and discover the SharePoint host name.
import { execFileSync } from 'node:child_process';

const isWin = process.platform === 'win32';
const azd = (args) => execFileSync(isWin ? 'azd.exe' : 'azd', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const blocked = { swedencentral: 'Sweden Central', westeurope: 'West Europe', germanywestcentral: 'Germany West Central', northeurope: 'North Europe' };
const location = (process.env.AZURE_LOCATION ?? '').toLowerCase();
if (blocked[location]) {
  console.error(`\n${blocked[location]} is listed as "high demand, prevents the creation of new search services". Choose another region, e.g.:\n  azd env set AZURE_LOCATION francecentral\n`);
  process.exit(1);
}

if (!process.env.SHAREPOINT_HOSTNAME) {
  const args = ['auth', 'token', '--scope', 'https://graph.microsoft.com/.default', '--output', 'json'];
  if (process.env.AZURE_TENANT_ID) args.push('--tenant-id', process.env.AZURE_TENANT_ID);
  let host;
  try {
    const { token } = JSON.parse(azd(args));
    const res = await fetch('https://graph.microsoft.com/v1.0/sites/root?$select=siteCollection', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) host = (await res.json()).siteCollection?.hostname;
    if (!host) {
      const org = await (await fetch('https://graph.microsoft.com/v1.0/organization?$select=verifiedDomains', { headers: { Authorization: `Bearer ${token}` } })).json();
      const initial = org.value?.[0]?.verifiedDomains?.find((d) => d.isInitial)?.name;
      if (initial) host = `${initial.split('.')[0].toLowerCase()}.sharepoint.com`;
    }
  } catch (e) {
    console.error(e.message);
  }
  if (!host) {
    console.error('\nCould not discover the SharePoint host name. Set it explicitly:\n  azd env set SHAREPOINT_HOSTNAME <tenant>.sharepoint.com\n');
    process.exit(1);
  }
  azd(['env', 'set', 'SHAREPOINT_HOSTNAME', host]);
  console.log(`SHAREPOINT_HOSTNAME=${host}`);
}
