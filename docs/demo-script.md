# Demo script (about 10 minutes)

Personas are created by the setup script. Their sign-in names and Temporary Access Passes are in
`.azure/<env>/demo-credentials.txt`. Use a **private/incognito window per persona** (tokens are kept in session storage).
The complete list of prompts and expected results per persona is in [test-plan.md](test-plan.md).

## Who has access to what (and at which level)

Permissions are granted at two scopes. **Site** means a role assignment on the site, which every folder and document
inherits unless it has unique permissions. **Folder** means the folder broke inheritance, so only the listed principals (plus
the site Owners group) can read the folder and every document in it.

| Site / folder | Inheritance | Who has access | How it's granted | Level |
|---|---|---|---|---|
| **Research** (site) | — | *All staff* (Entra group: Alice, Bob, Carol) | Site role assignment | Read |
| Research / **Public** | Inherits from site | *All staff* → Alice, Bob, Carol | Site (inherited) | Read |
| Research / **Quantum** | **Unique** (inheritance broken) | *Quantum team* (Entra group: Alice) | Folder role assignment to an Entra group | Read |
| Research / **Bio** | **Unique** (inheritance broken) | Carol | Folder role assignment to a **user** (direct) | Read |
| **Finance** (site) | — | Bob | Member of the SharePoint **Members** site group (Bob added directly) | Edit (Members default) |
| Finance / **Reports** | Inherits from site | Bob | Site (inherited, via the *Members* group) | Edit |
| **HR** (site) | — | *All staff* → Alice, Bob, Carol | Site role assignment | Read |
| HR / **Confidential** | Inherits from site | *All staff* → Alice, Bob, Carol | Site (inherited) | Read — **but never indexed** |

The deploying admin owns all three sites (*Owners* SharePoint group, Full Control) and keeps access to the unique
folders as well.

### Per persona

| Persona | Research / Public | Research / Quantum | Research / Bio | Finance / Reports | HR / Confidential (in SharePoint) | Visible in search |
|---|---|---|---|---|---|---|
| **Alice** | ✅ site Read (All staff) | ✅ folder Read (Quantum team group) | ⛔ | ⛔ no site access | ✅ site Read (All staff) | BLUEBIRD, AURORA |
| **Bob** | ✅ site Read (All staff) | ⛔ unique, not listed | ⛔ unique, not listed | ✅ site Edit (SharePoint *Members* group) | ✅ site Read (All staff) | BLUEBIRD, NIGHTJAR |
| **Carol** | ✅ site Read (All staff) | ⛔ unique, not listed | ✅ folder Read (direct user) | ⛔ no site access | ✅ site Read (All staff) | BLUEBIRD, KESTREL |
| **admin@** | ✅ Owners (Full Control) | ✅ Owners | ✅ Owners | ✅ Owners | ✅ Owners | everything except OSPREY |

### The ingestion app (what gets indexed)

| Site | `Sites.Selected` grant | Result |
|---|---|---|
| Research | `read` | Indexed with item-level ACLs (`ixr-research`) |
| Finance | `read` | Indexed with item-level ACLs (`ixr-finance`) |
| HR | **none** | Graph returns 403. Azure AI Search refuses to create the indexer (`accessDenied`), so there are only **two** indexers. Everyone can read HR **in SharePoint**, yet OSPREY never appears in search |

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
