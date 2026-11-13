targetScope = 'subscription'

@minLength(1)
@maxLength(20)
@description('azd environment name, used to name the resource group and resources.')
param environmentName string

@description('Azure region. Sweden Central, West Europe, North Europe and Germany West Central currently block new search services (high demand), so France Central is the default.')
@allowed([
  'francecentral'
  'switzerlandnorth'
  'uksouth'
  'polandcentral'
  'italynorth'
  'eastus'
  'eastus2'
  'westus3'
])
param location string = 'francecentral'

@description('Object ID of the deploying admin (set automatically by azd).')
param principalId string

@description('SharePoint host name, e.g. contoso.sharepoint.com (discovered by the preprovision hook).')
param sharePointHostname string

@description('Prefix for the SharePoint site URLs and Entra object names.')
@maxLength(12)
param demoPrefix string = 'acldemo'

@description('Chat model for the grounded answers.')
param chatModelName string = 'gpt-4.1-mini'
param chatModelVersion string = '2025-04-14'
param chatDeploymentCapacity int = 30

@description('Embedding model used by the skillset and the query-time vectorizer.')
param embeddingModelName string = 'text-embedding-3-large'
param embeddingModelVersion string = '1'
param embeddingDeploymentCapacity int = 30
@allowed(['GlobalStandard', 'Standard'])
param deploymentSkuName string = 'GlobalStandard'

@description('Least-privilege spike switch: when true the ingestion app also gets tenant-wide Microsoft Graph Files.Read.All.')
param grantFilesReadAll bool = false

@description('True after the first azd deploy so re-provisioning keeps the deployed image.')
param webAppExists bool = false

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var tags = { 'azd-env-name': environmentName, demo: 'aisearch-sharepoint-acl' }

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module core 'modules/core.bicep' = {
  name: 'core'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    principalId: principalId
    chatModelName: chatModelName
    chatModelVersion: chatModelVersion
    chatDeploymentCapacity: chatDeploymentCapacity
    embeddingModelName: embeddingModelName
    embeddingModelVersion: embeddingModelVersion
    embeddingDeploymentCapacity: embeddingDeploymentCapacity
    deploymentSkuName: deploymentSkuName
  }
}

var webAppName = 'ca-web-${resourceToken}'
var webUrl = 'https://${webAppName}.${core.outputs.containerAppsDefaultDomain}'

module entra 'modules/entra.bicep' = {
  name: 'entra'
  scope: rg
  params: {
    namePrefix: '${demoPrefix}-${environmentName}'
    principalId: principalId
    webUrl: webUrl
    searchIdentityPrincipalId: core.outputs.searchIdentityPrincipalId
    webIdentityPrincipalId: core.outputs.webIdentityPrincipalId
    grantFilesReadAll: grantFilesReadAll
  }
}

var siteBase = 'https://${sharePointHostname}/sites/${demoPrefix}'

module web 'modules/web.bicep' = {
  name: 'web'
  scope: rg
  params: {
    location: location
    tags: tags
    name: webAppName
    exists: webAppExists
    containerAppsEnvironmentName: core.outputs.containerAppsEnvironmentName
    containerRegistryName: core.outputs.containerRegistryName
    identityId: core.outputs.webIdentityId
    identityClientId: core.outputs.webIdentityClientId
    env: [
      { name: 'AZURE_TENANT_ID', value: tenant().tenantId }
      { name: 'AZURE_CLIENT_ID', value: core.outputs.webIdentityClientId }
      { name: 'WEB_APP_CLIENT_ID', value: entra.outputs.webAppClientId }
      { name: 'INGEST_APP_CLIENT_ID', value: entra.outputs.ingestAppClientId }
      { name: 'SEARCH_ENDPOINT', value: core.outputs.searchEndpoint }
      { name: 'SEARCH_INDEX_NAME', value: 'sharepoint-acl-index' }
      { name: 'AZURE_OPENAI_ENDPOINT', value: core.outputs.openAiEndpoint }
      { name: 'AZURE_OPENAI_CHAT_DEPLOYMENT', value: core.outputs.chatDeploymentName }
      { name: 'SHAREPOINT_HOSTNAME', value: sharePointHostname }
      { name: 'SITE_RESEARCH_URL', value: '${siteBase}-research' }
      { name: 'SITE_FINANCE_URL', value: '${siteBase}-finance' }
      { name: 'SITE_HR_URL', value: '${siteBase}-hr' }
      { name: 'GROUP_ALL_STAFF_ID', value: entra.outputs.groupAllStaffId }
      { name: 'GROUP_QUANTUM_ID', value: entra.outputs.groupQuantumId }
      { name: 'GROUP_ADMINS_ID', value: entra.outputs.groupAdminsId }
      { name: 'PORT', value: '8080' }
    ]
  }
}

output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = core.outputs.containerRegistryLoginServer
output SEARCH_SERVICE_NAME string = core.outputs.searchName
output SEARCH_ENDPOINT string = core.outputs.searchEndpoint
output SEARCH_INDEX_NAME string = 'sharepoint-acl-index'
output SEARCH_IDENTITY_RESOURCE_ID string = core.outputs.searchIdentityId
output SEARCH_IDENTITY_CLIENT_ID string = core.outputs.searchIdentityClientId
output WEB_IDENTITY_CLIENT_ID string = core.outputs.webIdentityClientId
output AZURE_OPENAI_ENDPOINT string = core.outputs.openAiEndpoint
output AZURE_OPENAI_CHAT_DEPLOYMENT string = core.outputs.chatDeploymentName
output AZURE_OPENAI_EMBEDDING_DEPLOYMENT string = core.outputs.embeddingDeploymentName
output AZURE_OPENAI_EMBEDDING_MODEL string = embeddingModelName
output INGEST_APP_CLIENT_ID string = entra.outputs.ingestAppClientId
output INGEST_APP_DISPLAY_NAME string = entra.outputs.ingestAppDisplayName
output WEB_APP_CLIENT_ID string = entra.outputs.webAppClientId
output SETUP_APP_CLIENT_ID string = entra.outputs.setupAppClientId
output GROUP_ALL_STAFF_ID string = entra.outputs.groupAllStaffId
output GROUP_QUANTUM_ID string = entra.outputs.groupQuantumId
output GROUP_DEMO_USERS_ID string = entra.outputs.groupDemoUsersId
output GROUP_ADMINS_ID string = entra.outputs.groupAdminsId
output DEMO_PREFIX string = demoPrefix
output SHAREPOINT_HOSTNAME string = sharePointHostname
output SITE_RESEARCH_URL string = '${siteBase}-research'
output SITE_FINANCE_URL string = '${siteBase}-finance'
output SITE_HR_URL string = '${siteBase}-hr'
output WEB_URL string = webUrl
