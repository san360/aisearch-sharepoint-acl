# Demo script (about 10 minutes)

Personas are created by the setup script. Their sign-in names and Temporary Access Passes are in
`.azure/<env>/demo-credentials.txt`. Use a **private/incognito window per persona** (tokens are kept in session storage).
The complete list of prompts and expected results per persona is in [test-plan.md](test-plan.md).

## Who has access to what (and at which level)

### The three SharePoint sites

Each is a separate **site collection** (communication site). Folders live in the site's default *Documents* library
(`Shared Documents`). `acldemo` is the default `DEMO_PREFIX`.

| Site key | SharePoint site name | Site URL | Folders in *Documents* |
|---|---|---|---|
| Research | **ACL Demo - Research** | `https://<tenant>.sharepoint.com/sites/acldemo-research` | `Public`, `Quantum`, `Bio` |
| Finance | **ACL Demo - Finance** | `https://<tenant>.sharepoint.com/sites/acldemo-finance` | `Reports` |
| HR | **ACL Demo - HR Confidential** | `https://<tenant>.sharepoint.com/sites/acldemo-hr` | `Confidential` |

Permissions are granted at two scopes:

* **Site-level**: a role assignment on the site. Every folder and document inherits it unless it has unique permissions.
* **Folder-level (unique)**: the folder broke inheritance, so only the listed principals (plus the site *Owners* group)
  can read the folder and every document in it. Site-level grants such as *All staff* no longer apply there.

### Permissions per location

| SharePoint site | Folder | Scope | Granted to | How | Level |
|---|---|---|---|---|---|
| ACL Demo - Research | *(whole site)* | **Site** | *All staff* (Entra group: Alice, Bob, Carol) | Site role assignment | Read |
| ACL Demo - Research | `Public` | Site (inherited) | *All staff* | Inherits from the site | Read |
| ACL Demo - Research | `Quantum` | **Folder (unique)** | *Quantum team* (Entra group: Alice) | Folder role assignment to an Entra group | Read |
| ACL Demo - Research | `Bio` | **Folder (unique)** | Carol | Folder role assignment to a **user** (direct) | Read |
| ACL Demo - Finance | *(whole site)* | **Site** | Bob | Member of the SharePoint **Members** site group | Edit (Members default) |
| ACL Demo - Finance | `Reports` | Site (inherited) | Bob | Inherits from the site (via *Members*) | Edit |
| ACL Demo - HR Confidential | *(whole site)* | **Site** | *All staff* | Site role assignment | Read |
| ACL Demo - HR Confidential | `Confidential` | Site (inherited) | *All staff* | Inherits from the site | Read — **never indexed** |

The deploying admin owns all three sites (*Owners* SharePoint group, Full Control), including the unique folders.

### Per persona

Rows are SharePoint locations; ✅ / ⛔ is what the persona can open **in SharePoint**, with the scope and the reason.

| SharePoint site | Folder | Codeword | Alice | Bob | Carol | admin@ |
|---|---|---|---|---|---|---|
| ACL Demo - Research | `Public` | BLUEBIRD | ✅ Site Read — *All staff* | ✅ Site Read — *All staff* | ✅ Site Read — *All staff* | ✅ Site Owner |
| ACL Demo - Research | `Quantum` | AURORA | ✅ **Folder** Read — *Quantum team* group | ⛔ unique folder, not listed | ⛔ unique folder, not listed | ✅ Site Owner |
| ACL Demo - Research | `Bio` | KESTREL | ⛔ unique folder, not listed | ⛔ unique folder, not listed | ✅ **Folder** Read — direct user | ✅ Site Owner |
| ACL Demo - Finance | `Reports` | NIGHTJAR | ⛔ no access to the site | ✅ Site Edit — SharePoint *Members* group | ⛔ no access to the site | ✅ Site Owner |
| ACL Demo - HR Confidential | `Confidential` | OSPREY | ✅ Site Read — *All staff* | ✅ Site Read — *All staff* | ✅ Site Read — *All staff* | ✅ Site Owner |
| **Visible in search** | | | BLUEBIRD, AURORA | BLUEBIRD, NIGHTJAR | BLUEBIRD, KESTREL | all except OSPREY |

OSPREY is readable by everyone in SharePoint but never appears in search: the HR site isn't granted to the ingestion app.

### The ingestion app (what gets indexed)

| SharePoint site | `Sites.Selected` grant | Result |
|---|---|---|
| ACL Demo - Research | `read` | Indexed with item-level ACLs (`ixr-research`) |
| ACL Demo - Finance | `read` | Indexed with item-level ACLs (`ixr-finance`) |
| ACL Demo - HR Confidential | **none** | Graph returns 403. Azure AI Search refuses to create the indexer (`accessDenied`), so there are only **two** indexers. Everyone can read HR **in SharePoint**, yet OSPREY never appears in search |

Each folder holds one *Access note* (with the codeword) and arXiv papers; documents inherit the folder's permissions. The
full document list (D1–D14) is in [test-plan.md](test-plan.md#1-documents-and-who-can-read-them).

## 0. Set the scene (admin, *How it works* tab)

* Three SharePoint sites, five folders, five codewords.
* The **live** who-can-see-what matrix is computed now, not hard-coded. Signed in as an admin, every persona's row comes
  from the ACL stored on each access note plus live Entra and SharePoint group lookups, and each ✔ says why (👤 direct,
  👥 Entra group, 🟦 SharePoint site group). HR shows *not indexed — no Sites.Selected grant*. Click **Re-run** after
  changing a membership.
* Signed in as a persona, only your own row is computed: each cell is confirmed by a real trimmed query with your token
  (🔎 found / hidden).
* In the Search tab, open **Raw request & response** to show the exact JSON sent to Azure AI Search
  (`x-ms-query-source-authorization` header, `queryType`, `vectorQueries`) and the trimmed response.

## 1. Alice — Entra group access

Codeword chips run in **Keyword** mode (an exact match). Topic chips run in **Hybrid** mode, whose vector half always
returns the nearest chunks you can access.

1. Sign in as Alice. Her header shows *All staff* and *Quantum team*.
2. Search `AURORA` → the Research/Quantum access note and quantum papers.
3. Search `KESTREL` → **No results for you** (Bio is shared with Carol only).
4. Search `NIGHTJAR` → nothing (Finance).
5. **Ask**: *"Which codewords can I see, and which folders do they belong to?"* → BLUEBIRD and AURORA only, with citations.

## 2. Bob — SharePoint site group

1. Sign in as Bob. Search `NIGHTJAR` → Finance documents (access via the SharePoint **Members** site group, stored as
   `spg:` in the index and resolved at query time).
2. Search `superconducting qubits` (hybrid) → **only** Research/Public results, never the Quantum papers, even though they
   are the best semantic match.

## 3. Carol — direct user share

1. Sign in as Carol. Search `KESTREL` → Research/Bio.
2. Search `AURORA` → nothing.

## 4. HR — admin consent ≠ access

1. Any persona: search `OSPREY` → nothing. Everyone can read the HR site in SharePoint, but the ingestion app was never
   granted it.
2. Open the **Sites.Selected proof** tab: Research/Finance → HTTP 200, HR → HTTP 403; `ixr-hr` failed with access denied;
   roles claim = `Sites.Selected`.

## 5. Live change without re-indexing (admin)

1. As the admin, **Admin** tab → *Live membership change* → **Add to Quantum team** for Carol.
2. Back in Carol's window, search `AURORA` again → results appear immediately (Entra groups are resolved at query time).
3. Remove her again → results disappear.

## 6. Look under the hood (admin)

* **Who can see what** (elevated read): every chunk with its stored `UserIds` / `GroupIds` resolved to names.
* **Indexers**: status, schedule, **Run now**, **Resync ACLs** (needed after site/library/folder permission changes).

## REST version

[`demo/queries.http`](../demo/queries.http) runs the same queries with the VS Code REST Client so you can show the raw
`x-ms-query-source-authorization` header and the elevated-read comparison.
