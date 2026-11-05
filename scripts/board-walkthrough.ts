#!/usr/bin/env bun
/**
 * Increment 1 of `specs/BOARD-FLOW-SPEC.md`. Drives throwaway issues through
 * every board lane using REAL events and reports what each lane did.
 *
 * Dispatch only. It creates and deletes real issues, a branch and a pull
 * request; a schedule is the thing #1744 exists to remove.
 *
 * Rows 3 and 6 are expected RED — nothing writes In progress or Cancelled
 * today. They ship red on purpose; see `lib/board-walkthrough.ts` for why
 * that needs a verdict of its own, and why the OPPOSITE reading
 * (`UNEXPECTED_PASS`) is the one worth watching for.
 */
import {
  WALKTHROUGH_STEPS,
  stepVerdict,
  runVerdict,
  reportLines,
  type Lane,
  type Reading,
  type Step,
} from "../lib/board-walkthrough";
import { readBoardCredential } from "../lib/board-ready-fanout";

/** Every refusal goes through one constant, so a test can mutate it. */
export const EXIT_REFUSED = 2;

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

async function gql(token: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ query, variables }),
  });
  // `r.ok` BEFORE the body means anything — an expired PAT returns a plain
  // `{"message": …}` carrying neither `data` nor `errors`, and returning that
  // makes a credential failure look like an empty board. Same defect
  // `scripts/board-ready.ts` carries a comment about.
  if (!r.ok) throw new Error(`${r.status} from the GraphQL endpoint`);
  const j = (await r.json()) as { data?: any; errors?: unknown };
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

async function rest(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${await r.text()}`);
  return r.status === 204 ? null : await r.json();
}

/**
 * The lane an issue is in, read fresh from the board every time.
 *
 * `(absent)` is a real reading and not an error: an item that is not on the
 * board at all is exactly what row 6 expects of a `not_planned` close today,
 * and collapsing it into "no status" would make the Cancelled gap invisible.
 */
async function laneOf(token: string, project: string, issueNodeId: string): Promise<Lane> {
  const d = await gql(
    token,
    `query($i:ID!){node(id:$i){... on Issue{projectItems(first:20){nodes{
       project{id}
       fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`,
    { i: issueNodeId },
  );
  const items = d?.node?.projectItems?.nodes ?? [];
  const mine = items.find((it: any) => it?.project?.id === project);
  if (!mine) return "(absent)";
  return (mine.fieldValueByName?.name ?? "(absent)") as Lane;
}

/**
 * Poll until the lane matches, or the budget expires.
 *
 * **The expiry is a failure, not a retry.** It returns the LAST observed lane
 * and says the wait expired; it never loops until the answer is convenient.
 * A writer that is merely slow and a writer that does not exist produce the
 * same observation here, and the caller is told which it saw.
 */
async function awaitLane(
  token: string,
  project: string,
  nodeId: string,
  want: Lane,
  budgetMs: number,
): Promise<{ observed: Lane; waitExpired: boolean }> {
  const deadline = Date.now() + budgetMs;
  let observed: Lane = "(absent)";
  while (Date.now() < deadline) {
    observed = await laneOf(token, project, nodeId);
    if (observed === want) return { observed, waitExpired: false };
    await new Promise(r => setTimeout(r, 5_000));
  }
  return { observed, waitExpired: true };
}

interface Made {
  readonly number: number;
  /**
   * The REST DATABASE id, which is not the number and is not interchangeable
   * with it. The dependencies endpoint takes this one — see the call site.
   */
  readonly id: number;
  readonly nodeId: string;
}

async function createIssue(token: string, repo: string, title: string): Promise<Made> {
  const j = await rest(token, "POST", `/repos/${repo}/issues`, {
    title,
    body:
      "Throwaway issue created by `scripts/board-walkthrough.ts` to observe a board " +
      "lane transition on a real event. It deletes itself. If you are reading this, " +
      "the run died between creation and cleanup — delete it.",
  });
  return { number: j.number, id: j.id, nodeId: j.node_id };
}

async function closeIssue(token: string, repo: string, n: number, reason: "completed" | "not_planned") {
  await rest(token, "PATCH", `/repos/${repo}/issues/${n}`, { state: "closed", state_reason: reason });
}

/** Issues cannot be deleted over REST; `deleteIssue` is GraphQL-only. */
async function deleteIssue(token: string, nodeId: string) {
  await gql(token, `mutation($i:ID!){deleteIssue(input:{issueId:$i}){clientMutationId}}`, { i: nodeId });
}

async function deleteBranch(token: string, repo: string, branch: string) {
  await rest(token, "DELETE", `/repos/${repo}/git/refs/heads/${branch}`);
}

/**
 * The scratch file one run commits, named after that run.
 *
 * **Per-run, because row 5 merges into the default branch.** A fixed path
 * makes this a one-shot instrument: the first successful walk-through leaves
 * the file on main for good, and the next run's create is a 422 on a file
 * that already exists. A stamped path also survives a run that died between
 * the merge and the cleanup below — the leftover is inert rather than a
 * blocker, which is the case a `sha`-retry does not cover.
 */
const scratchPath = (stamp: string) => `.github/walkthrough-scratch-${stamp}.md`;

/**
 * A branch with one throwaway commit, created entirely over REST.
 *
 * No `git` and no checkout: this runs before any clone and the walk-through
 * has no reason to hold a working tree. It also keeps every artefact this
 * script creates deletable by the same `finally` that deletes the issues.
 */
async function createBranchWithCommit(
  token: string,
  repo: string,
  branch: string,
  base: string,
  path: string,
) {
  const head = await rest(token, "GET", `/repos/${repo}/git/ref/heads/${base}`);
  await rest(token, "POST", `/repos/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: head.object.sha,
  });
  await rest(token, "PUT", `/repos/${repo}/contents/${path}`, {
    message: "chore: throwaway commit for the board walk-through",
    content: Buffer.from(`Created by the board walk-through at ${new Date().toISOString()}.\n`).toString("base64"),
    branch,
  });
}

/**
 * Remove the scratch file from the default branch after row 5 merged it there.
 *
 * Row 5 has to squash-merge into the DEFAULT branch, because GitHub's "pull
 * request merged" built-in fires nowhere else — so a successful walk-through
 * necessarily puts its scratch file on main. Deleting the branch does not
 * undo that; the squashed commit is already on main.
 *
 * This leaves two commits of noise per run on a `walkthrough-scratch-*` path
 * and no file. That is the honest cost of driving a real merge, and it is
 * cheaper than a repository that accrues one scratch file per run forever.
 */
async function deleteScratchFromBase(token: string, repo: string, path: string, base: string) {
  const cur = await rest(token, "GET", `/repos/${repo}/contents/${path}?ref=${base}`);
  await rest(token, "DELETE", `/repos/${repo}/contents/${path}`, {
    message: "chore: remove the board walk-through's throwaway commit",
    sha: cur.sha,
    branch: base,
  });
}

async function main(): Promise<number> {
  const repo = arg("repo");
  const project = arg("project");
  const budgetMs = Number(arg("wait-seconds") ?? "90") * 1000;
  if (repo === null || project === null) {
    console.error("UNMEASURED: --repo <owner/name> --project <id> are both required");
    return EXIT_REFUSED;
  }
  const credential = readBoardCredential(process.env);
  if (credential.kind === "UNMEASURED") {
    console.log(`::warning::UNMEASURED — ${credential.why}. Nothing was created and nothing was read.`);
    return EXIT_REFUSED;
  }
  const token = credential.token;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const scratch = scratchPath(stamp);
  const made: Made[] = [];
  const readings: Reading[] = [];
  let branch: string | null = null;
  let prNumber: number | null = null;
  let mergedPr = false;
  const byRow = new Map<number, Step>(WALKTHROUGH_STEPS.map(s => [s.n, s]));
  const record = async (n: number, nodeId: string) => {
    const s = byRow.get(n)!;
    const { observed, waitExpired } = await awaitLane(token, project, nodeId, s.expect, budgetMs);
    readings.push({ step: s, observed, verdict: stepVerdict(s, observed), waitExpired });
  };

  try {
    // Rows 1 and 2 — A blocks B, then A closes and B should become Ready.
    const a = await createIssue(token, repo, `walkthrough ${stamp} A (blocker)`);
    const b = await createIssue(token, repo, `walkthrough ${stamp} B (blocked)`);
    made.push(a, b);
    // **`issue_id` is the REST DATABASE id, and the number does not fail.**
    // Measured 2026-11-05 on two throwaway issues: `issue_id=1770` (a repo
    // number) returned 200 and linked issue #4; `issue_id=6229750699`
    // (#1770's database id) linked #1770. So the wrong value is accepted and
    // resolves to a DIFFERENT issue — the walk-through would have blocked B
    // on something unrelated, watched Ready not move, and reported the Ready
    // lane broken. A false reading from the instrument built to stop false
    // readings. Caught by `ai-review` on this pull request.
    await rest(token, "POST", `/repos/${repo}/issues/${b.number}/dependencies/blocked_by`, {
      issue_id: a.id,
    });
    await record(1, b.nodeId);

    // Row 7 — the negative control, read BEFORE A closes, while B's blocker
    // is still open. Sharing B is deliberate: a separate issue would let the
    // control pass against a board that treats the two differently for a
    // reason unrelated to blockers.
    await record(7, b.nodeId);

    await closeIssue(token, repo, a.number, "completed");
    await record(2, b.nodeId);

    // Row 3 — In progress. Nothing writes it; expected RED.
    await rest(token, "POST", `/repos/${repo}/issues/${b.number}/assignees`, { assignees: ["hornjason"] });
    await record(3, b.nodeId);

    // Rows 4 and 5 — a real pull request, because the two native workflows
    // that move In review and Done cannot be faked. They fire on genuine
    // activity or not at all, which is the whole reason this file exists
    // rather than another fixture.
    //
    // The closing keyword matters twice: GitHub's "pull request linked to
    // issue" built-in needs it to link B at all, and the "pull request
    // merged" built-in only fires for a PR into the DEFAULT branch carrying
    // one.
    branch = `walkthrough/${stamp}`;
    await createBranchWithCommit(token, repo, branch, "main", scratch);
    const pr = await rest(token, "POST", `/repos/${repo}/pulls`, {
      title: `walkthrough ${stamp} — throwaway, auto-deleted`,
      head: branch,
      base: "main",
      body: `Fixes #${b.number}\n\nThrowaway pull request from the board walk-through. It deletes itself.`,
      draft: false,
    });
    prNumber = pr.number;
    await record(4, b.nodeId);

    // Row 5 needs the merge to actually happen. A PR that cannot merge —
    // required checks pending, a protected branch — leaves row 5 reading
    // `waitExpired` against a lane that was never given the chance, so the
    // failure says so rather than blaming the Done writer.
    try {
      await rest(token, "PUT", `/repos/${repo}/pulls/${prNumber}/merge`, { merge_method: "squash" });
      mergedPr = true;
    } catch (e) {
      console.log(
        `::warning::row 5 UNMEASURED — the throwaway pull request could not be merged (${e}). ` +
          `The Done lane was never given an event, so its reading below is about the merge, not the lane.`,
      );
    }
    await record(5, b.nodeId);

    // Row 6 — a not_planned close. Nothing moves it out of the lanes today.
    const c = await createIssue(token, repo, `walkthrough ${stamp} C (cancelled)`);
    made.push(c);
    await closeIssue(token, repo, c.number, "not_planned");
    await record(6, c.nodeId);
  } finally {
    // **In a `finally`.** A step that throws is the case most likely to
    // litter the tracker, and it is exactly the case a trailing cleanup call
    // misses. Each deletion is independently guarded so one failure does not
    // strand the rest.
    if (prNumber !== null && !mergedPr) {
      try {
        await rest(token, "PATCH", `/repos/${repo}/pulls/${prNumber}`, { state: "closed" });
      } catch (e) {
        console.log(`::warning::could not close throwaway pull request #${prNumber}: ${e}`);
      }
    }
    // Only after a MERGE is the scratch file on main. An unmerged run never
    // put it there, and asking for it would 404 — which would read as a
    // cleanup failure for a file that was correctly absent.
    if (mergedPr) {
      try {
        await deleteScratchFromBase(token, repo, scratch, "main");
      } catch (e) {
        console.log(
          `::warning::the throwaway commit ${scratch} is still on main (${e}). ` +
            `Delete it by hand — a later run will not be blocked by it, but it is litter.`,
        );
      }
    }
    if (branch !== null) {
      try {
        await deleteBranch(token, repo, branch);
      } catch (e) {
        console.log(`::warning::could not delete throwaway branch ${branch}: ${e}`);
      }
    }
    for (const m of made) {
      try {
        await deleteIssue(token, m.nodeId);
      } catch (e) {
        console.log(`::warning::could not delete throwaway issue #${m.number}: ${e}`);
      }
    }
  }

  for (const line of reportLines(readings)) console.log(line);
  const v = runVerdict(readings);
  console.log(v.ok ? `\nOK — ${v.why}` : `\n::error::${v.why}`);
  const surprises = readings.filter(r => r.verdict === "UNEXPECTED_PASS");
  for (const s of surprises) {
    console.log(
      `::warning::row ${s.step.n} was expected RED and PASSED — the ${s.step.expect} ` +
        `lane has started working. Update specs/BOARD-FLOW-SPEC.md before this is forgotten.`,
    );
  }
  return v.ok ? 0 : 1;
}

main().then(c => process.exit(c));
