# Demo script (about 10 minutes)

Personas are created by the setup script. Their sign-in names and Temporary Access Passes are in
`.azure/<env>/demo-credentials.txt`. Use a **private/incognito window per persona** (tokens are kept in session storage).
The complete list of prompts and expected results per persona is in [test-plan.md](test-plan.md).

## Who has access to what (and at which level)

### The SharePoint sites

Three **site collections** (communication sites), plus one **subsite** and one extra **document library** inside Research.
Folders live in the default *Documents* library (`Shared Documents`) unless noted. `acldemo` is the default `DEMO_PREFIX`.

| Site key | SharePoint site name | Site URL | Folders in *Documents* |
|---|---|---|---|
| Research | **ACL Demo - Research** | `https://<tenant>.sharepoint.com/sites/acldemo-research` | `Public`, `Quantum`, `Bio` · second library **Archive**: `Notes` |
| ↳ LLM Lab (subsite of Research) | **ACL Demo - LLM Lab** | `https://<tenant>.sharepoint.com/sites/acldemo-research/llmlab` | `Papers`, `Drafts` |
| Finance | **ACL Demo - Finance** | `https://<tenant>.sharepoint.com/sites/acldemo-finance` | `Reports` |
| HR | **ACL Demo - HR Confidential** | `https://<tenant>.sharepoint.com/sites/acldemo-hr` | `Confidential` |

> The LLM Lab **subsite** is only created when subsite creation is enabled for the tenant (one-time UI setting, see
> [indexing-scopes.md](indexing-scopes.md#subsites)). Without it the setup skips the subsite and everything else works;
> HERON and MAGPIE then show *subsite not created* in the app.

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
| ACL Demo - Research | *Archive* library › `Notes` | Site (inherited) | *All staff* | Inherits from the site | Read |
| ACL Demo - LLM Lab *(subsite)* | *(whole subsite)* | **Subsite (unique)** | *Quantum team* (Alice) + Bob | Subsite role assignments (inheritance from Research broken) | Read |
| ACL Demo - LLM Lab *(subsite)* | `Papers` | Subsite (inherited) | *Quantum team* + Bob | Inherits from the subsite | Read |
| ACL Demo - LLM Lab *(subsite)* | `Drafts` | **Folder (unique)** | Bob | Folder role assignment to a **user** (direct) | Read |
| ACL Demo - Finance | *(whole site)* | **Site** | Bob | Member of the SharePoint **Members** site group | Edit (verified) |
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
| ACL Demo - Research | *Archive* › `Notes` | WREN | ✅ Site Read — *All staff* | ✅ Site Read — *All staff* | ✅ Site Read — *All staff* | ✅ Site Owner |
| ACL Demo - LLM Lab *(subsite)* | `Papers` | HERON | ✅ **Subsite** Read — *Quantum team* group | ✅ **Subsite** Read — direct user | ⛔ unique subsite, not listed | ✅ Site Owner |
| ACL Demo - LLM Lab *(subsite)* | `Drafts` | MAGPIE | ⛔ unique folder, not listed | ✅ **Folder** Read — direct user | ⛔ unique subsite, not listed | ✅ Site Owner |
| ACL Demo - Finance | `Reports` | NIGHTJAR | ⛔ no access to the site | ✅ Site Edit — SharePoint *Members* group | ⛔ no access to the site | ✅ Site Owner |
| ACL Demo - HR Confidential | `Confidential` | OSPREY | ✅ Site Read — *All staff* | ✅ Site Read — *All staff* | ✅ Site Read — *All staff* | ✅ Site Owner |
| **Visible in search** | | | BLUEBIRD, AURORA, WREN, HERON | BLUEBIRD, NIGHTJAR, WREN, HERON, MAGPIE | BLUEBIRD, KESTREL, WREN | all except OSPREY |

OSPREY is readable by everyone in SharePoint but never appears in search: the HR site isn't granted to the ingestion app.

### The ingestion app (what gets indexed)

| SharePoint site | `Sites.Selected` grant | Result |
|---|---|---|
| ACL Demo - Research | `read` | Indexed with item-level ACLs (`ixr-research`, container `allSiteLibraries` + `includeSubsites=true`): Documents, the **Archive** library and the **LLM Lab subsite** — one grant on the site collection covers its subsites |
| ACL Demo - Finance | `read` | Indexed with item-level ACLs (`ixr-finance`, `defaultSiteLibrary`) |
| ACL Demo - HR Confidential | **none** | Graph returns 403. Azure AI Search refuses to create the indexer (`accessDenied`), so there are only **two** indexers. Everyone can read HR **in SharePoint**, yet OSPREY never appears in search |

Each folder holds one *Access note* (with the codeword) and arXiv papers; documents inherit the folder's permissions. The
full document list (D1–D20) is in [test-plan.md](test-plan.md#1-documents-and-who-can-read-them).

## 0. Set the scene (admin, *How it works* and *Access* tabs)

* **Access** tab: the same tables as above, read live from SharePoint. Click a site or folder to open it in SharePoint (new tab, same sign-in); as a persona, a protected folder shows SharePoint's own access-denied page. *You · SharePoint* and *You · search* agree everywhere except HR (readable, never indexed).

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

## 7. More queries: paper-specific and complex

All expectations below were checked against the live index with elevated read. Alice can read **Public + Quantum**, Bob
**Public + Reports**, Carol **Public + Bio**. Nobody gets HR. Use **Keyword** mode unless stated otherwise, and open
*Raw request & response* to show the query that was sent.

### The papers

| Short name | Paper (arXiv) | SharePoint site / folder |
|---|---|---|
| **Chunk boundaries** | Calibrating Document-Local Boundaries for Contextual Chunk Retrieval (2611.12097) | ACL Demo - Research / `Public` |
| **Semantic IDs** | Not All Branches Are Equal — Adaptive Semantic ID Construction for Generative Recommendation (2611.11549) | ACL Demo - Research / `Public` |
| **Jet identification** | Beauty and charm jet identification … on a superconducting quantum processor (2611.16607) | ACL Demo - Research / `Quantum` |
| **Gatemon qubits** | Gatemon qubits based on in-situ ternary InAsSb-Al nanowire Josephson junctions (2611.16595) | ACL Demo - Research / `Quantum` |
| **Gene → image** | Understanding Gene Expression-to-Image Learning (2610.17699) | ACL Demo - Research / `Bio` |
| **CloneOT** | CloneOT — clone-specific perturbation responses with neural inverse optimal transport (2610.16093) | ACL Demo - Research / `Bio` |
| **Credit behaviour PD** | A Functional Representation of Credit Behavior for Probability of Default Modeling (2610.07888) | ACL Demo - Finance / `Reports` |
| **LGD credit cards** | Comparing two approaches for modelling the loss given default of credit cards (2610.05926) | ACL Demo - Finance / `Reports` |
| **Owning What Can Quit** | Owning What Can Quit (2611.02302) | ACL Demo - HR Confidential / `Confidential` (never indexed) |

### 7a. Paper-specific (one paper each)

| Query | Finds | Alice | Bob | Carol |
|---|---|---|---|---|
| `"semantic ID"` | Semantic IDs | ✅ | ✅ | ✅ |
| `"chunk retrieval"` | Chunk boundaries | ✅ | ✅ | ✅ |
| `gatemon` | Gatemon qubits | ✅ | 🔒 | 🔒 |
| `InAsSb` | Gatemon qubits | ✅ | 🔒 | 🔒 |
| `"jet identification"` | Jet identification | ✅ | 🔒 | 🔒 |
| `lineage` | CloneOT | 🔒 | 🔒 | ✅ |
| `"gene expression"` | Gene → image (+ a few CloneOT chunks) | 🔒 | 🔒 | ✅ |
| `"run-off triangles"` | LGD credit cards | 🔒 | ✅ | 🔒 |
| `"probability of default"` | Credit behaviour PD (+ 1 LGD chunk) | 🔒 | ✅ | 🔒 |
| `"Owning What Can Quit"` | — (HR, never indexed) | 🔒 | 🔒 | 🔒 |

### 7b. Same query, different answers (terms in several folders)

| Query | Indexed in | Alice sees | Bob sees | Carol sees |
|---|---|---|---|---|
| `"neural network"` | Quantum, Bio, Reports | Jet identification | Credit behaviour PD, LGD credit cards | CloneOT, Gene → image |
| `calibration` | Public, Quantum, Reports | Chunk boundaries, Jet identification, Gatemon qubits | Chunk boundaries, Credit behaviour PD | Chunk boundaries |
| `recommendation` | Public, Quantum, Reports | Semantic IDs, Gatemon qubits | Semantic IDs, LGD credit cards | Semantic IDs |
| `boundaries` | Public, Quantum, Bio | Chunk boundaries, Semantic IDs, Jet identification | Chunk boundaries, Semantic IDs | Chunk boundaries, Semantic IDs, Gene → image |
| `regression` | Bio, Reports | 🔒 nothing | Both Finance papers | Both Bio papers |
| `transformer` | Public, Bio | Semantic IDs, Chunk boundaries | Semantic IDs, Chunk boundaries | Semantic IDs, Chunk boundaries, Gene → image |
| `codeword` | every access note (+ Semantic IDs) | Public + Quantum notes | Public + Reports notes | Public + Bio notes |

### 7c. Query syntax (simple query syntax, the app's default)

| Query | What it does | Alice | Bob | Carol |
|---|---|---|---|---|
| `BLUEBIRD \| AURORA \| KESTREL \| NIGHTJAR \| OSPREY` | OR across all codewords | Public, Quantum notes | Public, Reports notes | Public, Bio notes |
| `BLUEBIRD + AURORA` | AND: no note has both | 🔒 | 🔒 | 🔒 |
| `gatemon \| "gene expression" \| "probability of default"` | OR of three phrases from three folders | Gatemon qubits | Credit behaviour PD, LGD credit cards | Gene → image, CloneOT |
| `"optimal transport" \| "jet identification" \| "semantic ID"` | OR across Public, Quantum, Bio | Semantic IDs, Jet identification | Semantic IDs | Semantic IDs, CloneOT, Gene → image |
| `+neural +credit` | AND (both required) | 🔒 | Both Finance papers | 🔒 |
| `+neural +lineage` | AND | 🔒 | 🔒 | CloneOT |
| `+regression +spatial` | AND | 🔒 | 🔒 | Gene → image |
| `+calibration +retrieval` | AND | Chunk boundaries | Chunk boundaries | Chunk boundaries |
| `qubit*` / `Josephson*` | prefix | Both Quantum papers | 🔒 | 🔒 |
| `transcript*` | prefix | 🔒 | 🔒 | Both Bio papers |

> **Gotcha:** `-` (NOT) in the default `searchMode=any` means "OR NOT". `quantum -qubit` therefore matches almost every
> chunk (≈ 330 before trimming). Use `+` for required terms instead.

### 7d. Natural-language questions (Semantic or Hybrid)

In **Hybrid**, check the *keyword match* / *vector neighbour only* badges: a persona without access gets neighbours from their
own folders, never the protected paper.

| Query | Alice | Bob | Carol |
|---|---|---|---|
| `how are superconducting qubits fabricated from nanowires` | Gatemon qubits first | Only Public/Reports neighbours | Only Public/Bio neighbours |
| `predicting how cell clones respond to perturbations` | Only Public/Quantum neighbours | Only Public/Reports neighbours | CloneOT first |
| `estimating credit card losses after default` | Only Public/Quantum neighbours | LGD credit cards first | Only Public/Bio neighbours |
| `where should a document be split into chunks for retrieval` | Chunk boundaries first | Chunk boundaries first | Chunk boundaries first |

### 7e. Ask tab (RAG)

| Question | Alice | Bob | Carol |
|---|---|---|---|
| *What is a gatemon qubit and which material is the junction made of?* | Answers from Gatemon qubits (InAsSb-Al nanowire) | "Not in my sources" | "Not in my sources" |
| *Which flavours of jets are identified, and on what hardware?* | Beauty and charm, superconducting quantum processor | No access | No access |
| *What does CloneOT predict and how is it trained?* | No access | No access | Clone-specific perturbation responses, lineage supervision |
| *Compare run-off triangles and regression for loss given default.* | No access | Answers from LGD credit cards | No access |
| *How do semantic IDs improve generative recommendation?* | Answers (Public) | Answers (Public) | Answers (Public) |
| *Which of my documents use neural networks, and for what?* | Jet identification (+ Public) | Finance papers (+ Public) | Bio papers (+ Public) |
| *Summarise everything I can access in one paragraph per folder.* | Public, Quantum | Public, Reports | Public, Bio |
| *Is there anything about who owns what can quit?* | Nothing (HR not indexed) | Nothing | Nothing |

Use **New conversation** between personas' scenarios so earlier answers don't leak context into the next question.

## 8. Libraries and subsites (one data source, whole site collection)

The Research data source uses `allSiteLibraries` + `includeSubsites=true`, so one indexer covers the default library, the
second **Archive** library and the **LLM Lab** subsite. All container options are tested in
[indexing-scopes.md](indexing-scopes.md).

| Query (Keyword) | Location | Alice | Bob | Carol |
|---|---|---|---|---|
| `WREN` | Research › Archive library / Notes | ✅ | ✅ | ✅ |
| `HERON` | LLM Lab subsite / Papers | ✅ (Quantum team on the subsite) | ✅ (direct on the subsite) | 🔒 |
| `MAGPIE` | LLM Lab subsite / Drafts (unique) | 🔒 | ✅ (direct on the folder) | 🔒 |
| `"data corruption"` | LLM Lab / Papers paper | ✅ | ✅ | 🔒 |
| `"token pruning"` | LLM Lab / Drafts paper (DiFiT) | 🔒 | ✅ | 🔒 |
| `"software engineering research"` | LLM Lab / Papers paper | ✅ | ✅ | 🔒 |

Talking points:

1. With `defaultSiteLibrary` (scenario S1) WREN and the subsite would never be indexed — scope is a data source
   decision, not a permission.
2. The `Sites.Selected` grant on the **site collection** covers the subsite: no extra grant.
3. Bob reaches the subsite through a **direct** subsite permission and MAGPIE through a **folder** permission; Alice
   through an **Entra group** on the subsite; Carol has nothing there although she can read the parent site.
4. In the **Access** tab, the subsite row is indented under Research and its folders show *Inherits from subsite* /
   *Unique*.

Ask tab: *How are large language models reshaping software engineering research?* — Alice and Bob get an answer from the
LLM Lab paper; Carol gets "not in my sources".

## REST version

[`demo/queries.http`](../demo/queries.http) runs the same queries with the VS Code REST Client so you can show the raw
`x-ms-query-source-authorization` header and the elevated-read comparison.
