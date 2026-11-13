import { ManagedIdentityCredential, AzureDeveloperCliCredential, ClientAssertionCredential } from '@azure/identity';
import { config } from './config.mjs';

// In Azure: the web app's user-assigned managed identity.
// Locally: the developer's azd login (run `azd auth login` first).
export const appCredential = config.runningInAzure
  ? new ManagedIdentityCredential({ clientId: config.managedIdentityClientId })
  : new AzureDeveloperCliCredential({ tenantId: config.tenantId });

export async function appToken(scope) {
  return (await appCredential.getToken(scope)).token;
}

// The ingestion app (Sites.Selected) via its federated credential that trusts
// the web managed identity. Only available when running in Azure.
let ingest;
export function ingestCredential() {
  if (!config.runningInAzure) return null;
  ingest ??= new ClientAssertionCredential(config.tenantId, config.ingestClientId, async () =>
    (await appCredential.getToken('api://AzureADTokenExchange/.default')).token);
  return ingest;
}

export function decodeJwt(token) {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}
