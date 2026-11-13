import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PublicClientApplication } from '@azure/msal-node';
import { env, log } from './util.mjs';

// Delegated tokens for Microsoft Graph and SharePoint come from the
// deployment-only "setup" public client app. The admin signs in once in the
// browser (MFA applies); delegated rights are bounded by the admin's own rights.

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url.replace(/&/g, '^&')] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  return Promise.resolve();
}

let pca;
let account;

function cachePlugin(file) {
  return {
    beforeCacheAccess: async (ctx) => {
      if (fs.existsSync(file)) ctx.tokenCache.deserialize(fs.readFileSync(file, 'utf8'));
    },
    afterCacheAccess: async (ctx) => {
      if (ctx.cacheHasChanged) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, ctx.tokenCache.serialize(), { mode: 0o600 });
      }
    },
  };
}

function client() {
  if (pca) return pca;
  const envName = env('AZURE_ENV_NAME', 'local');
  const cacheFile = path.resolve('.azure', envName, '.msal-cache.json');
  pca = new PublicClientApplication({
    auth: {
      clientId: env('SETUP_APP_CLIENT_ID'),
      authority: `https://login.microsoftonline.com/${env('AZURE_TENANT_ID')}`,
    },
    cache: { cachePlugin: cachePlugin(cacheFile) },
  });
  return pca;
}

export async function delegatedToken(resource) {
  const scopes = [`${resource.replace(/\/$/, '')}/.default`];
  const app = client();
  if (!account) {
    const accounts = await app.getTokenCache().getAllAccounts();
    account = accounts.find((a) => a.tenantId === env('AZURE_TENANT_ID'));
  }
  if (account) {
    try {
      return (await app.acquireTokenSilent({ account, scopes })).accessToken;
    } catch {
      /* fall through to interactive */
    }
  }
  log.info(`Opening the browser for the admin sign-in (setup app, ${resource})...`);
  const res = await app.acquireTokenInteractive({
    scopes,
    openBrowser,
    prompt: 'select_account',
    successTemplate: '<h2>Signed in. You can close this tab and return to the terminal.</h2>',
    errorTemplate: '<h2>Sign-in failed: {error}</h2>',
  });
  account = res.account;
  return res.accessToken;
}

export const graphToken = () => delegatedToken('https://graph.microsoft.com');
export const sharePointToken = () => delegatedToken(`https://${env('SHAREPOINT_HOSTNAME')}`);
