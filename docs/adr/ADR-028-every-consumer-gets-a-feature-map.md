---
doc-type: adr
status: accepted
created: 2026-11-25
updated: 2026-11-25
---

# ADR-028 — Every consumer gets a feature map, and a card for each feature, generated from what the project declares

## Status

**Accepted, 2026-11-26.** Jason merged it in #2857. Jason chose the shape after reviewing a mock-up built from DailyBriefDashboard's real data ("worth it: draft the rungate ADR"). The DDB consumer session drafted it, and the rungate session numbered it, wrote its criteria with `create-sc`, and fixed the file paths. Decisions 1 and 4, and the wording of SC-2812 to SC-2818 below, are as merged. Still open: everything under "Not decided here".

## Context

Jason asked for one drillable view of a project. It shows what each feature is supposed to do, what it is made of, whether it works right now, whether its proof is real, and where it is bloated. He wants it at two levels: an overview of data flowing through the whole engine, and a panel for each feature. The panel borrows the idea of Lean's InfoView, which shows the intended state next to the actual state wherever you look. The view must be generated, so it cannot drift. Rungate should deliver it to every consumer, not just DDB.

A mock-up was built read-only on DDB at `8a8b3b96`: a feature census, drill-down cards for four features (cases, campaigns, intelligence and saleshub), and an engine map. What it measured:

- **Facts a project declares are trustworthy.** DDB's 35 modules come from its registry, mirrored by `docs/REFRESH-MATRIX.md`, and a DDB test fails when that mirror is stale. Its 18 pages come from the dashboard router. Schedules, what each module looks for, and its AI call types are all declared and generated.
- **The links between them are not declared, so a generator can only guess.**
  - 26 of the 35 modules declare no page or account tab.
  - 5 of the engine topology's 11 consumers exist only in its hand-kept list. The same list names saleshub's source as "Red Hat APIs" and cases' as "Salesforce". The code says a Drive file and Red Hat's v3 Case Management API.
  - Which files belong to a feature disagrees by method. Comparing files the module's own code imports with files named for the feature: cases 5 against 8, agreeing on 3; campaigns 1 against 16, agreeing on 1; intelligence 5 against 13, agreeing on 3.
  - Matching ADRs to features by text finds either 16 ADRs for "cases" (the word in prose) or none.
- **Some links are declared, just not used.** ADR criteria tables name 70 distinct criteria across 10 of DDB's 44 ADRs, and 18 more criteria cite an ADR in their own text. Each table row also lists the files the criterion will change. Specs now name the claims they serve (`serves:`, DDB #2450).
- **What is typed by hand can be found mechanically.** With only the registered names and the generated-file markers, a scan found:
  - 42 quoted lists in 17 files that name registered features. 15 of them hold a name matching no feature, and 9 hold an old name of a current feature. A generator-validated `dependsOn` list was skipped every time (12 of 12).
  - 162 documents, of which 3 are generated and checked, 1 is generated with nothing checking it is current, and 158 are typed by hand.
  - Hand-typed totals that disagree with the registry. One document says 31 modules, another says 21, and the registry has 35.
  - Compared feature by feature, 21 of 35 features disagree with the hand-typed source list: 4 wrong, 3 partial, 9 missing, 5 under an old name.
- **Rungate's own generic layer misses most of the tree.** `CODE-MAP.md` lists 62 of DDB's 375 API routes, because `scanRoutes` in `scripts/generate-code-map.ts` matches only `app.<method>(`, and 16 of its 18 pages.
- **The card showed a real gap.** For cases, 34 tests load its files, and a mutation record showed 28 of them able to fail. But the criteria firmly linked to it are rules every module shares. Its own source checks list `src/rh-cases-api.ts` in their ADR rows and have no test yet. That is the shape of the 10 weeks in which Red Hat's case API changed and nothing noticed.

## Decision

Nothing changes when this ADR merges. Once every row below ships:

1. A consumer writes a **feature manifest**: a JSON file in a schema rungate defines, produced by the consumer's own adapter from what its code declares. It is hash-stamped, and a conformity test fails when it is stale.
2. Rungate fills in the **generic layers** itself:
   - routes and pages, from a code map that reads every router;
   - each feature's files, from the import graph of the entry files the manifest names;
   - churn and size, from git;
   - the proof chain, from claims (`serves:`) to criteria, tests and mutation records, with ADR links taken from ADR criteria tables.
3. Every derived number keeps the row it came from, and carries **where it came from**, as one of five classes:
   - generated and checked: a script writes it, and a test fails when it is stale;
   - declared in code: typed next to the code, in the feature's own definition;
   - typed by hand: kept apart from the code, and nothing checks it;
   - mock-up guess;
   - live: read from a status endpoint the manifest names.
4. `rungate feature-map` renders **one self-contained page**: an overview of sources, features and consumers, where clicking any node opens that feature's card, with intended state, actual state, proof and gaps. Every number can be drilled down to the rows that produced it, and a card whose count disagrees with its rows is not rendered.
5. A **declare-or-fail check** reports every page, route and source file that no feature declares or marks shared. A **typed-by-hand scan** reports the hand-kept lists, documents and totals described above. Both start as reports.
6. Agents read the **same manifest JSON**, so a card is also what an agent loads before editing a feature.

## Decisions

1. **The manifest is the contract, and app-specific facts come only from the consumer's adapter — Jason decides.** Rungate never guesses a feature's files, consumers or sources by name. The mock-up showed those guesses disagree by up to 15 files.
2. **Rungate generates everything generic, and every derived number keeps its row and its class — the DA recommends.** A card that says "34 tests" must list the 34, say why each one counts, and say which of the five classes the number is. The class is what tells a reader where drift can live: only the typed-by-hand class can disagree with the code unseen.
3. **One page: the overview map plus a card per feature — the DA recommends.** A consumer that already generates maps can later read the same manifest rather than keep a second model.
4. **Declare-or-fail and the typed-by-hand scan start as reports — Jason decides.** Each becomes a refusal for a consumer once that consumer's report is empty, so no consumer goes red on the day it upgrades. The typed-by-hand scan's thresholds are first values measured on DDB at `8a8b3b96`: a quoted list counts when 2 or more of its items, and 60% or more of them, are registered names; and a cue-word filter drops historical counts. They are re-measured on the second consumer before either check refuses anything.
5. **Live status is optional — the DA recommends.** A manifest may name a read-only status endpoint. Without one, the card says "not measured", never "fresh".
6. **DDB is the pilot consumer — the DA recommends.** Its adapter is a DDB issue. It builds on DDB's ADR-061 work: the outside-source inventory (DDB's SC-113, which records how each source is found and who approved each fixed target) and the generated system map (DDB's SC-114, whose module-to-module links come from `dependsOn`). It also reads each module's own registry declarations (`sources`, `dependsOn`), which already exist and which DDB's refresh-matrix test keeps current.
7. **Agents read the manifest JSON directly until a query service is decided — the DA recommends.** No second model is kept for agents.

## Not decided here

- Whether a consumer is using a feature's output correctly, as consumer contract tests (Pact-style). The manifest records consumers; checking them is later work.
- A code-health score beyond churn and size, such as hotspots that weigh complexity against change frequency.
- An MCP server so agents can query the manifest. Agents read the same JSON until then.
- Consumers that are not TypeScript.

## Criteria

Written in `specs/SCAFFOLD-DECOMPOSITION-SPEC.md` by `create-sc`, which governs the code map today. Their block in `specs/sc-reservations.json` was released when this ADR was accepted, because the written lines now hold all seven ids. Quoted here once so the wording could be approved:

- SC-2812: Rungate publishes a feature-manifest schema, and its validator refuses a manifest that names a file, page or route the tree does not hold (behavioral)
- SC-2813: The code map lists every route registered on any router a file creates, and every page in the router, and says how many routes it could not attribute to a router (behavioral)
- SC-2814: Rungate derives each feature's proof chain (claims, criteria, tests, mutation records) and its ADRs from ADR criteria tables, keeping the source row and the provenance class of every link (behavioral)
- SC-2815: rungate feature-map renders one self-contained page, an overview of sources, features and consumers where each node opens a drill-down card, and refuses to render a card whose derived count disagrees with the rows it lists (behavioral)
- SC-2816: The generated conformity test refuses a stale feature manifest, and reports every page, route and source file that no feature declares or marks shared (behavioral)
- SC-2817: The scaffold ships the feature-map command and a rule that states the adapter contract (behavioral)
- SC-2818: Rungate reports what is typed by hand: quoted lists that name registered features, documents nothing generates or checks, and hand-typed totals that disagree with the registry (behavioral)

## Decomposition

SC-2813 is the code-map routes gap a consumer reported on 2026-11-25. It is placed here instead of filed alone, because the feature map reads the routes it produces.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| SC-2812 | Feature manifest schema and validator | lib/feature-manifest.ts, test/feature-manifest.test.ts | — | — |
| SC-2813 | Code map reads every router and every page | scripts/generate-code-map.ts, test/gen-code-map.test.ts | — | — |
| SC-2814 | Proof chain and ADR links derived per feature with each link's row and class | lib/feature-proof.ts, test/feature-proof.test.ts | — | Feature manifest schema and validator |
| SC-2818 | Typed-by-hand scan reports hand-kept lists and documents and totals | lib/hand-typed-scan.ts, test/hand-typed-scan.test.ts | — | Feature manifest schema and validator |
| SC-2815 | Feature map page with overview and drill-down cards | scripts/feature-map.ts, templates/feature-map.html, lib/cli-commands.ts, package.json, test/feature-map.test.ts | — | Proof chain and ADR links derived per feature with each link's row and class |
| SC-2816 | Conformity refuses a stale manifest and reports undeclared files | lib/conformity.ts, test/feature-manifest-conformity.test.ts | — | Feature manifest schema and validator |
| SC-2817 | Scaffold ships the feature-map command and adapter rule | lib/scaffold/feature-map-step.ts, lib/scaffold/owned-files.ts, test/scaffold-feature-map.test.ts | — | Feature map page with overview and drill-down cards |

Evidence for a reviewer: the mock-up's scripts and outputs are in the DDB consumer session's `~/.rungate/drafts/feature-audit/` and `~/.rungate/drafts/proof-map/`.
