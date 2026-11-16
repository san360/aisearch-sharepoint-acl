param location string
param tags object
param resourceToken string
param principalId string
param chatModelName string
param chatModelVersion string
param chatDeploymentCapacity int
param embeddingModelName string
param embeddingModelVersion string
param embeddingDeploymentCapacity int
param deploymentSkuName string

// ---------- Identities ----------
// Search service identity: the SharePoint indexer exchanges its token for an
// ingestion-app token through a federated identity credential (no secrets).
resource searchIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-search-${resourceToken}'
  location: location
  tags: tags
}

// Web app identity: calls Search/OpenAI and runs the Sites.Selected proof probe.
resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-web-${resourceToken}'
  location: location
  tags: tags
}

// ---------- Monitoring ----------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${resourceToken}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

// ---------- Azure AI Search ----------
resource search 'Microsoft.Search/searchServices@2025-05-01' = {
  name: 'srch-${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'basic' }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${searchIdentity.id}': {} }
  }
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'Default'
    semanticSearch: 'free'
    publicNetworkAccess: 'enabled'
    // Keys are disabled: every caller uses Microsoft Entra ID + RBAC.
    disableLocalAuth: true
  }
}

// ---------- Azure OpenAI ----------
resource openAi 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'oai-${resourceToken}'
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: 'oai-${resourceToken}'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
  }
}

resource embeddingDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openAi
  name: embeddingModelName
  sku: { name: deploymentSkuName, capacity: embeddingDeploymentCapacity }
  properties: {
    model: { format: 'OpenAI', name: embeddingModelName, version: embeddingModelVersion }
  }
}

resource chatDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openAi
  name: chatModelName
  sku: { name: deploymentSkuName, capacity: chatDeploymentCapacity }
  properties: {
    model: { format: 'OpenAI', name: chatModelName, version: chatModelVersion }
  }
  dependsOn: [embeddingDeployment]
}

// ---------- Container Apps ----------
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'cr${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource containerAppsEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${resourceToken}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

// ---------- Role assignments ----------
var roles = {
  openAiUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
  searchIndexDataContributor: '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
  searchServiceContributor: '7ca78c08-252a-4471-8644-bb5ff32d4ba0'
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
}

// Search identity -> OpenAI (embedding skill + query-time vectorizer)
resource searchToOpenAi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: openAi
  name: guid(openAi.id, searchIdentity.id, roles.openAiUser)
  properties: {
    principalId: searchIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.openAiUser)
  }
}

// Web identity -> OpenAI (chat)
resource webToOpenAi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: openAi
  name: guid(openAi.id, webIdentity.id, roles.openAiUser)
  properties: {
    principalId: webIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.openAiUser)
  }
}

// Web identity -> Search, least privilege (custom role). The app only needs to:
//   query (documents/read; results are still ACL-trimmed with the user's token), read index stats, read indexer
//   status and run/resync indexers from the Admin tab. It can NOT upload or merge documents (so it can't rewrite
//   UserIds/GroupIds), change the index, skillset or data sources, turn off permissionFilterOption, or touch keys.
//   Elevated read is done with the admin's own token, not this identity. See docs/index-integrity.md.
resource webSearchRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'search-acl-demo-web')
  properties: {
    roleName: 'Search ACL demo web app (${resourceToken})'
    description: 'Query an index, read index stats and indexer status, run/resync indexers. No document writes, no schema or pipeline changes, no keys.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: [
          'Microsoft.Search/searchServices/indexes/read'
          'Microsoft.Search/searchServices/indexers/read'
          'Microsoft.Search/searchServices/indexers/write'
        ]
        dataActions: [
          'Microsoft.Search/searchServices/indexes/documents/read'
        ]
      }
    ]
  }
}

resource webToSearch 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: search
  name: guid(search.id, webIdentity.id, 'search-acl-demo-web')
  properties: {
    principalId: webIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: webSearchRole.id
  }
}

// Search diagnostic logs (index/indexer/data source changes, document uploads, queries) for tamper detection.
resource searchDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'search-to-log-analytics'
  scope: search
  properties: {
    workspaceId: logs.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

resource webToAcr 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, webIdentity.id, roles.acrPull)
  properties: {
    principalId: webIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
  }
}

// Deploying admin -> Search (create pipeline objects, elevated read) + OpenAI (local dev)
var adminSearchRoles = [roles.searchIndexDataContributor, roles.searchServiceContributor]
resource adminToSearch 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for r in adminSearchRoles: {
  scope: search
  name: guid(search.id, principalId, r)
  properties: {
    principalId: principalId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', r)
  }
}]

resource adminToOpenAi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: openAi
  name: guid(openAi.id, principalId, roles.openAiUser)
  properties: {
    principalId: principalId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.openAiUser)
  }
}

output searchName string = search.name
output searchEndpoint string = 'https://${search.name}.search.windows.net'
output searchIdentityId string = searchIdentity.id
output searchIdentityClientId string = searchIdentity.properties.clientId
output searchIdentityPrincipalId string = searchIdentity.properties.principalId
output webIdentityId string = webIdentity.id
output webIdentityClientId string = webIdentity.properties.clientId
output webIdentityPrincipalId string = webIdentity.properties.principalId
output openAiEndpoint string = openAi.properties.endpoint
output chatDeploymentName string = chatDeployment.name
output embeddingDeploymentName string = embeddingDeployment.name
output containerRegistryName string = registry.name
output containerRegistryLoginServer string = registry.properties.loginServer
output containerAppsEnvironmentName string = containerAppsEnv.name
output containerAppsDefaultDomain string = containerAppsEnv.properties.defaultDomain
output appInsightsConnectionString string = appInsights.properties.ConnectionString
