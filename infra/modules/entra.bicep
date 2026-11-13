// Microsoft Entra objects, declared with the Microsoft Graph Bicep extension.
extension microsoftGraphV1

param namePrefix string
@description('Object ID of the deploying admin.')
param principalId string
param webUrl string
param searchIdentityPrincipalId string
param webIdentityPrincipalId string
param grantFilesReadAll bool

var graphAppId = '00000003-0000-0000-c000-000000000000'
var sharePointAppId = '00000003-0000-0ff1-ce00-000000000000'
var searchAppId = '880da380-985e-4198-81b9-e05b1cc53158'
var ficIssuer = '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'

resource graphSp 'Microsoft.Graph/servicePrincipals@v1.0' existing = {
  appId: graphAppId
}
resource sharePointSp 'Microsoft.Graph/servicePrincipals@v1.0' existing = {
  appId: sharePointAppId
}
resource searchSp 'Microsoft.Graph/servicePrincipals@v1.0' existing = {
  appId: searchAppId
}

// ---------- Security groups ----------
resource groupAllStaff 'Microsoft.Graph/groups@v1.0' = {
  uniqueName: '${namePrefix}-all-staff'
  displayName: '${namePrefix} All staff'
  description: 'ACL demo: everyone (Alice, Bob, Carol). Granted Read on the Research site.'
  mailEnabled: false
  mailNickname: '${namePrefix}-all-staff'
  securityEnabled: true
}

resource groupQuantum 'Microsoft.Graph/groups@v1.0' = {
  uniqueName: '${namePrefix}-quantum-team'
  displayName: '${namePrefix} Quantum team'
  description: 'ACL demo: granted Read on the Research/Quantum folder only (Alice).'
  mailEnabled: false
  mailNickname: '${namePrefix}-quantum-team'
  securityEnabled: true
}

resource groupDemoUsers 'Microsoft.Graph/groups@v1.0' = {
  uniqueName: '${namePrefix}-demo-users'
  displayName: '${namePrefix} Demo personas'
  description: 'ACL demo personas. Used only to scope Temporary Access Pass issuance.'
  mailEnabled: false
  mailNickname: '${namePrefix}-demo-users'
  securityEnabled: true
}

resource groupAdmins 'Microsoft.Graph/groups@v1.0' = {
  uniqueName: '${namePrefix}-admins'
  displayName: '${namePrefix} Demo admins'
  description: 'Members can open the Admin tab (elevated read, indexer controls).'
  mailEnabled: false
  mailNickname: '${namePrefix}-admins'
  securityEnabled: true
  members: {
    relationshipSemantics: 'append'
    relationships: [principalId]
  }
}

// ---------- 1. Ingestion app (used by the SharePoint indexer) ----------
// Least privilege: Sites.Selected only. Admin consent alone grants access to
// NO site; each site must be granted explicitly (done by the setup script for
// Research and Finance, deliberately NOT for HR).
var graphIngestRoles = union(['Sites.Selected'], grantFilesReadAll ? ['Files.Read.All'] : [])
// SharePoint API permissions are required to ingest SharePoint site groups and
// to resolve them at query time (sharePointConnectorAppRegistration).
var sharePointIngestRoles = ['Sites.Selected', 'User.Read.All']

resource ingestApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: '${namePrefix}-spo-ingest'
  displayName: '${namePrefix} SharePoint ingestion (Sites.Selected)'
  signInAudience: 'AzureADMyOrg'
  notes: 'Used by the Azure AI Search SharePoint indexer. Secretless: federated credentials trust managed identities.'
  requiredResourceAccess: [
    {
      resourceAppId: graphAppId
      resourceAccess: [for r in graphIngestRoles: {
        id: filter(graphSp.appRoles, x => x.value == r)[0].id
        type: 'Role'
      }]
    }
    {
      resourceAppId: sharePointAppId
      resourceAccess: [for r in sharePointIngestRoles: {
        id: filter(sharePointSp.appRoles, x => x.value == r)[0].id
        type: 'Role'
      }]
    }
  ]

  resource ficSearch 'federatedIdentityCredentials@v1.0' = {
    name: '${ingestApp.uniqueName}/search-indexer-mi'
    description: 'Trusts the Azure AI Search user-assigned managed identity.'
    audiences: ['api://AzureADTokenExchange']
    issuer: ficIssuer
    subject: searchIdentityPrincipalId
  }

  resource ficWeb 'federatedIdentityCredentials@v1.0' = {
    name: '${ingestApp.uniqueName}/web-proof-mi'
    description: 'Trusts the web app managed identity (Sites.Selected proof probe only).'
    audiences: ['api://AzureADTokenExchange']
    issuer: ficIssuer
    subject: webIdentityPrincipalId
  }
}

resource ingestSp 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: ingestApp.appId
}

// Admin consent (application permissions)
resource ingestGraphConsent 'Microsoft.Graph/appRoleAssignedTo@v1.0' = [for r in graphIngestRoles: {
  appRoleId: filter(graphSp.appRoles, x => x.value == r)[0].id
  principalId: ingestSp.id
  resourceId: graphSp.id
}]

resource ingestSharePointConsent 'Microsoft.Graph/appRoleAssignedTo@v1.0' = [for r in sharePointIngestRoles: {
  appRoleId: filter(sharePointSp.appRoles, x => x.value == r)[0].id
  principalId: ingestSp.id
  resourceId: sharePointSp.id
}]

// ---------- 2. Web app (end-user sign-in, SPA + PKCE) ----------
// Files.Read.All + Sites.Read.All (delegated): the Access tab reads SharePoint folders and their permissions with the
// signed-in user's own token, so each user only sees what SharePoint already lets them see.
var webGraphScopes = ['openid', 'profile', 'offline_access', 'User.Read', 'Files.Read.All', 'Sites.Read.All']
// Sites.FullControl.All (delegated, deploying admin only): read the Sites.Selected app grants per site
// (GET /sites/{id}/permissions) in the Proof tab. Still bounded by the admin's own SharePoint rights.
var webAdminGraphScopes = ['GroupMember.ReadWrite.All', 'Sites.FullControl.All']

resource webApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: '${namePrefix}-web'
  displayName: '${namePrefix} ACL search demo'
  signInAudience: 'AzureADMyOrg'
  groupMembershipClaims: 'SecurityGroup'
  spa: {
    // MSAL Browser v5 redirect bridge page (served without COOP headers).
    redirectUris: [
      '${webUrl}/redirect'
      '${webUrl}/'
      'http://localhost:3000/redirect'
      'http://localhost:3000/'
    ]
  }
  requiredResourceAccess: [
    {
      resourceAppId: graphAppId
      resourceAccess: [for s in union(webGraphScopes, webAdminGraphScopes): {
        id: filter(graphSp.oauth2PermissionScopes, x => x.value == s)[0].id
        type: 'Scope'
      }]
    }
    {
      resourceAppId: searchAppId
      resourceAccess: [
        {
          id: filter(searchSp.oauth2PermissionScopes, x => x.value == 'user_impersonation')[0].id
          type: 'Scope'
        }
      ]
    }
  ]
}

resource webSp 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: webApp.appId
}

resource webGraphConsent 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = {
  clientId: webSp.id
  consentType: 'AllPrincipals'
  resourceId: graphSp.id
  scope: join(webGraphScopes, ' ')
}

resource webSearchConsent 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = {
  clientId: webSp.id
  consentType: 'AllPrincipals'
  resourceId: searchSp.id
  scope: 'user_impersonation'
}

// Only the deploying admin consents to group-membership changes (Admin tab
// "change membership" demo). Delegated, so still bounded by the admin's rights.
resource webAdminGraphConsent 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = {
  clientId: webSp.id
  consentType: 'Principal'
  principalId: principalId
  resourceId: graphSp.id
  scope: join(webAdminGraphScopes, ' ')
}

// ---------- 3. Setup app (deployment-time only, public client) ----------
// Used by the postprovision script with the admin's interactive sign-in to
// create SharePoint sites, folders, permissions, demo users and Sites.Selected
// grants. Delegated permissions are consented for the deploying admin only.
// Safe to delete after deployment.
var setupGraphScopes = [
  'openid'
  'profile'
  'offline_access'
  'User.Read'
  'Sites.FullControl.All'
  'Files.ReadWrite.All'
  'User.ReadWrite.All'
  'Group.ReadWrite.All'
  'Organization.Read.All'
  'LicenseAssignment.ReadWrite.All'
  'UserAuthenticationMethod.ReadWrite.All'
  'Policy.ReadWrite.AuthenticationMethod'
]
var setupSharePointScopes = ['AllSites.FullControl']

resource setupApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: '${namePrefix}-setup'
  displayName: '${namePrefix} setup (deployment only)'
  signInAudience: 'AzureADMyOrg'
  isFallbackPublicClient: true
  publicClient: {
    redirectUris: ['http://localhost']
  }
  requiredResourceAccess: [
    {
      resourceAppId: graphAppId
      resourceAccess: [for s in setupGraphScopes: {
        id: filter(graphSp.oauth2PermissionScopes, x => x.value == s)[0].id
        type: 'Scope'
      }]
    }
    {
      resourceAppId: sharePointAppId
      resourceAccess: [for s in setupSharePointScopes: {
        id: filter(sharePointSp.oauth2PermissionScopes, x => x.value == s)[0].id
        type: 'Scope'
      }]
    }
  ]
}

resource setupSp 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: setupApp.appId
}

resource setupGraphConsent 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = {
  clientId: setupSp.id
  consentType: 'Principal'
  principalId: principalId
  resourceId: graphSp.id
  scope: join(setupGraphScopes, ' ')
}

resource setupSharePointConsent 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = {
  clientId: setupSp.id
  consentType: 'Principal'
  principalId: principalId
  resourceId: sharePointSp.id
  scope: join(setupSharePointScopes, ' ')
}

// ---------- Web managed identity -> Graph (read-only) ----------
// GroupMember.Read.All: show the signed-in user's groups, admin-group check.
// User.ReadBasic.All: resolve ACL principal IDs to display names (Admin view).
var webMiGraphRoles = ['GroupMember.Read.All', 'User.ReadBasic.All']
resource webMiGraphRead 'Microsoft.Graph/appRoleAssignedTo@v1.0' = [for r in webMiGraphRoles: {
  appRoleId: filter(graphSp.appRoles, x => x.value == r)[0].id
  principalId: webIdentityPrincipalId
  resourceId: graphSp.id
}]

output ingestAppClientId string = ingestApp.appId
output ingestAppDisplayName string = ingestApp.displayName
output webAppClientId string = webApp.appId
output setupAppClientId string = setupApp.appId
output groupAllStaffId string = groupAllStaff.id
output groupQuantumId string = groupQuantum.id
output groupDemoUsersId string = groupDemoUsers.id
output groupAdminsId string = groupAdmins.id
