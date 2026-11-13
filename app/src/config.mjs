const e = (k, d) => process.env[k] ?? d;

export const config = {
  port: Number(e('PORT', '3000')),
  tenantId: e('AZURE_TENANT_ID'),
  webClientId: e('WEB_APP_CLIENT_ID'),
  ingestClientId: e('INGEST_APP_CLIENT_ID'),
  managedIdentityClientId: e('MANAGED_IDENTITY_CLIENT_ID'),
  searchEndpoint: e('SEARCH_ENDPOINT'),
  indexName: e('SEARCH_INDEX_NAME', 'sharepoint-acl-index'),
  searchApiVersion: e('SEARCH_API_VERSION', '2026-08-01-preview'),
  openAiEndpoint: e('AZURE_OPENAI_ENDPOINT'),
  chatDeployment: e('AZURE_OPENAI_CHAT_DEPLOYMENT', 'gpt-4.1-mini'),
  sharePointHost: e('SHAREPOINT_HOSTNAME'),
  groups: {
    allStaff: e('GROUP_ALL_STAFF_ID'),
    quantum: e('GROUP_QUANTUM_ID'),
    admins: e('GROUP_ADMINS_ID'),
    demoUsers: e('GROUP_DEMO_USERS_ID'),
  },
  sites: [
    { key: 'research', name: 'Research', url: e('SITE_RESEARCH_URL'), granted: true },
    { key: 'finance', name: 'Finance', url: e('SITE_FINANCE_URL'), granted: true },
    { key: 'hr', name: 'HR Confidential', url: e('SITE_HR_URL'), granted: false },
  ],
  runningInAzure: Boolean(process.env.CONTAINER_APP_NAME || process.env.IDENTITY_ENDPOINT),
};

const required = ['tenantId', 'webClientId', 'searchEndpoint', 'openAiEndpoint'];
export function missingConfig() {
  return required.filter((k) => !config[k]);
}

export function publicConfig() {
  return {
    tenantId: config.tenantId,
    clientId: config.webClientId,
    searchScope: 'https://search.azure.com/user_impersonation',
    graphAdminScope: 'https://graph.microsoft.com/GroupMember.ReadWrite.All',
    groups: config.groups,
    sites: config.sites.map(({ key, name, url, granted }) => ({ key, name, url, granted })),
    indexName: config.indexName,
    runningInAzure: config.runningInAzure,
  };
}
