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
    { key: 'research', name: 'ACL Demo - Research', url: e('SITE_RESEARCH_URL'), granted: true,
      folders: [{ name: 'Public', codeword: 'BLUEBIRD' }, { name: 'Quantum', codeword: 'AURORA' }, { name: 'Bio', codeword: 'KESTREL' },
        { name: 'Notes', codeword: 'WREN', library: 'Archive' }] },
    // Subsite of Research: same site collection, so the same Sites.Selected grant, data source and indexer.
    { key: 'llmlab', name: 'ACL Demo - LLM Lab', parent: 'research', url: e('SITE_RESEARCH_URL') && `${e('SITE_RESEARCH_URL')}/llmlab`, granted: true,
      folders: [{ name: 'Papers', codeword: 'HERON' }, { name: 'Drafts', codeword: 'MAGPIE' }] },
    { key: 'finance', name: 'ACL Demo - Finance', url: e('SITE_FINANCE_URL'), granted: true,
      folders: [{ name: 'Reports', codeword: 'NIGHTJAR' }] },
    { key: 'hr', name: 'ACL Demo - HR Confidential', url: e('SITE_HR_URL'), granted: false,
      folders: [{ name: 'Confidential', codeword: 'OSPREY' }] },
  ],
  runningInAzure: Boolean(process.env.CONTAINER_APP_NAME || process.env.IDENTITY_ENDPOINT),
};

export const collections = () => config.sites.filter((s) => !s.parent);

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
    graphSiteGrantsScope: 'https://graph.microsoft.com/Sites.FullControl.All',
    graphReadScopes: ['https://graph.microsoft.com/Files.Read.All', 'https://graph.microsoft.com/Sites.Read.All'],
    groups: config.groups,
    sites: config.sites.map(({ key, name, url, granted, folders, parent }) => ({ key, name, url, granted, folders, parent })),
    indexName: config.indexName,
    runningInAzure: config.runningInAzure,
  };
}
