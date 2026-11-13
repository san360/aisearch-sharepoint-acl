# Architecture

## Components

```mermaid
flowchart LR
  subgraph M365["Microsoft 365 tenant"]
    direction TB
    SPR["SharePoint site<br/>Research<br/>(granted)"]
    SPF["SharePoint site<br/>Finance<br/>(granted)"]
    SPH["SharePoint site<br/>HR Confidential<br/>(NOT granted)"]
    subgraph Entra["Microsoft Entra ID"]
      ING["App: spo-ingest<br/>Sites.Selected (Graph + SharePoint)<br/>FIC → search MI, web MI"]
      WEB["App: web (SPA)<br/>user_impersonation on Azure AI Search"]
      SET["App: setup<br/>(deployment only, delegated)"]
      GRP["Groups: all-staff, quantum-team,<br/>demo-users, admins"]
      USR["Users: Alice, Bob, Carol"]
    end
  end

  subgraph Azure["Azure resource group (France Central)"]
    SMI(["UAMI: search"])
    WMI(["UAMI: web"])
    SRCH["Azure AI Search (Basic)<br/>3 data sources + 3 indexers<br/>1 index · ACL fields per chunk"]
    AOAI["Azure OpenAI<br/>text-embedding-3-large<br/>gpt-4.1-mini"]
    ACA["Container App<br/>Node.js (Express) + vanilla UI"]
    ACR["Container Registry"]
    LOG["Log Analytics / App Insights"]
  end

  SMI -. "FIC token exchange" .-> ING
  WMI -. "FIC token exchange (proof probe)" .-> ING
  SRCH -- "indexer as spo-ingest" --> SPR & SPF
  SRCH -. "403: no site grant" .-> SPH
  SRCH -- "embed (MI)" --> AOAI
  ACA -- "query: MI + user token" --> SRCH
  ACA -- "chat (MI)" --> AOAI
  ACR --> ACA
  USR -- "sign in (MSAL, PKCE)" --> WEB
  WEB --> ACA
```

## Identities and permissions

| Identity | Type | Permissions | Used for |
|---|---|---|---|
| **spo-ingest** app | App registration, **no secret** | Graph `Sites.Selected` · SharePoint `Sites.Selected`, `User.Read.All` (application, admin-consented) + **per-site grant** on Research and Finance only | SharePoint indexer (content + ACLs), query-time SharePoint site group resolution |
| Search UAMI | User-assigned managed identity | Federated credential subject on spo-ingest · `Cognitive Services OpenAI User` | Indexer → SharePoint, embeddings, query vectorizer |
| Web UAMI | User-assigned managed identity | `Search Index Data Reader/Contributor`, `Search Service Contributor`, `Cognitive Services OpenAI User`, `AcrPull`, Graph `GroupMember.Read.All` + `User.ReadBasic.All` (application), FIC subject on spo-ingest | Query authorisation, chat, admin views, Sites.Selected probe |
| **web** app | SPA app registration | Delegated: `openid profile offline_access User.Read`, Azure AI Search `user_impersonation` (consented for all users), `GroupMember.ReadWrite.All` (consented for the deploying admin only) | End-user sign-in/out; the user token is what Azure AI Search uses to trim results |
| **setup** app | Public client | Delegated, consented for the deploying admin only: Graph `Sites.FullControl.All`, `Files.ReadWrite.All`, `User.ReadWrite.All`, `Group.ReadWrite.All`, `LicenseAssignment.ReadWrite.All`, `UserAuthenticationMethod.ReadWrite.All`, `Policy.ReadWrite.AuthenticationMethod`, `Organization.Read.All` · SharePoint `AllSites.FullControl` | Deployment-time only: create sites, folders, permissions, users, Sites.Selected grants. Safe to delete afterwards |
| Deploying admin | User | `Search Service Contributor`, `Search Index Data Contributor`, `Cognitive Services OpenAI User` | Creating the search pipeline, local development |

No API keys anywhere: Azure AI Search and Azure OpenAI have local (key) auth **disabled**.

## Ingestion flow

```mermaid
sequenceDiagram
  autonumber
  participant IX as Search indexer (ixr-research)
  participant MI as Search UAMI
  participant AAD as Microsoft Entra ID
  participant SP as SharePoint (Research site)
  participant AO as Azure OpenAI
  participant IDX as Index
  IX->>MI: get token (aud api://AzureADTokenExchange)
  IX->>AAD: client_credentials as spo-ingest, client_assertion = MI token
  AAD-->>IX: app-only token (roles: Sites.Selected)
  IX->>SP: list changed items + role assignments
  SP-->>IX: files + effective ACL (users, Entra groups, SharePoint groups)
  IX->>IX: crack PDF/MD, split into ~2000-char chunks
  IX->>AO: embed each chunk (MI auth)
  IX->>IDX: upsert chunks with UserIds, GroupIds (spg: for site groups), SharePointSiteUrl
```

For the **HR** site step 4 fails with *access denied*: the app's token is valid and admin-consented, but SharePoint has no site permission for it.

## Query flow

```mermaid
sequenceDiagram
  autonumber
  participant U as Browser (Alice)
  participant AAD as Microsoft Entra ID
  participant API as Web app (Express)
  participant S as Azure AI Search
  participant G as Microsoft Graph / SharePoint
  participant AO as Azure OpenAI
  U->>AAD: sign in (MSAL, auth code + PKCE)
  AAD-->>U: token aud=https://search.azure.com
  U->>API: POST /api/search  (Bearer user token)
  API->>API: validate JWT (issuer, audience, tenant)
  API->>S: search · Authorization: web MI · x-ms-query-source-authorization: user token
  S->>G: resolve oid → transitive Entra groups (+ SharePoint site groups on each site)
  S->>S: security filter on UserIds/GroupIds BEFORE ranking
  S-->>API: only chunks Alice may read
  API->>AO: (Ask tab) grounded prompt with trimmed chunks only
  AO-->>API: answer with citations
  API-->>U: results / answer
```

Key properties:

* The app never filters results itself — trimming happens inside Azure AI Search.
* Without a user token, ACL-protected documents are **not** returned (behaviour since the 2025-11-01-preview API).
* Entra group membership is resolved at **query time**: adding Carol to *Quantum team* takes effect on the next query, no re-indexing.
* If ACL evaluation fails (for example Graph unavailable) the service returns 5xx — never a partially filtered result.

## Data model (index `sharepoint-acl-index`)

| Field | Purpose |
|---|---|
| `chunk_id` (key), `parent_id` | Chunk and source-document keys (index projections, `skipIndexingParentDocuments`) |
| `title`, `url`, `path`, `site`, `last_modified` | SharePoint metadata (`metadata_spo_*`) |
| `chunk`, `chunk_vector` (3072-d) | Text and embedding; integrated vectorizer for queries |
| `UserIds` (`permissionFilter: userIds`) | Entra object IDs of users granted directly |
| `GroupIds` (`permissionFilter: groupIds`) | Entra group object IDs, and SharePoint site groups as `spg:<id>` |
| `SharePointSiteUrl` (`sharepointSiteUrl: true`) | Lets the service resolve SharePoint site groups per site at query time |

Index-level settings: `permissionFilterOption: enabled` and `sharePointConnectorAppRegistration` (spo-ingest app ID + search UAMI client ID).

## Demo content and permissions

| Site / folder | SharePoint permission | Who sees it | Codeword |
|---|---|---|---|
| Research / Public | inherits site: **All staff** Entra group = Read | Alice, Bob, Carol | BLUEBIRD |
| Research / Quantum | unique: **Quantum team** Entra group = Read | Alice | AURORA |
| Research / Bio | unique: **Carol** (direct user) = Read | Carol | KESTREL |
| Finance / Reports | inherits site: SharePoint **Members** site group (contains Bob) | Bob | NIGHTJAR |
| HR / Confidential | inherits site: All staff = Read, **but no Sites.Selected grant** | nobody (never indexed) | OSPREY |

Every folder contains an *Access note* markdown file with its codeword plus CC BY 4.0 arXiv papers on the folder's topic.
