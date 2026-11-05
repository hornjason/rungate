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
  unmeasuredReading,
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

/**
 * Poll until the pull request is mergeable, or the budget expires.
 *
 * Separate from `awaitLane` and with its own budget, because the two measure
 * different things on very different timescales. A lane either moves in
 * seconds or its writer does not exist; a pull request on this repository
 * waits on the `test` and `ai-review` required checks, which take minutes.
 * Sharing one budget would either make the lane waits uselessly long or the
 * merge wait guaranteed to expire.
 *
 * `mergeable_state` is read rather than `mergeable`: `clean` is the only
 * value that will actually merge, and `blocked` (checks pending or failed)
 * is the one this budget exists for. `unknown` means GitHub has not finished
 * computing it, which is a reason to keep waiting rather than to give up.
 */
async function awaitMergeable(token: string, repo: string, n: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let last = "unknown";
  while (Date.now() < deadline) {
    const pr = await rest(token, "GET", `/repos/${repo}/pulls/${n}`);
    last = pr.mergeable_state ?? "unknown";
    if (last === "clean" || last === "unstable") return true;
    if (last === "dirty") break;
    await new Promise(r => setTimeout(r, 15_000));
  }
  console.log(`::warning::pull request #${n} last read mergeable_state="${last}"`);
  return false;
}

async function main(): Promise<number> {
  const repo = arg("repo");
  const project = arg("project");
  const budgetMs = Number(arg("wait-seconds") ?? "90") * 1000;
  const mergeBudgetMs = Number(arg("merge-wait-seconds") ?? "900") * 1000;
  if (repo === null || project === null) {
    console.error("UNMEASURED: --repo <owner/name> --project <id> are both required");
    return EXIT_REFUSED;
  }
  // ## Two credentials, because they are scoped for different things
  //
  // `boardToken` is the PAT. `GITHUB_TOKEN` cannot read ProjectsV2 at all, at
  // any permission level, so the board read has to be the PAT and that is
  // GitHub's documented answer rather than a workaround here.
  //
  // `repoToken` performs every repository act. **Measured 2026-11-05, run
  // `42092949455`: the PAT returns `404 POST /repos/hornjason/rungate/issues`.**
  // `.github/workflows/board-intake.yml` records it as minted `read:project`
  // on 2026-11-02 and later measured carrying project WRITE — and project
  // scope is not repository scope. The walk-through is the first thing that
  // ever asked this credential to write a repository, which is why a token
  // in daily use turned out not to be able to.
  const credential = readBoardCredential(process.env);
  if (credential.kind === "UNMEASURED") {
    console.log(`::warning::UNMEASURED — ${credential.why}. Nothing was created and nothing was read.`);
    return EXIT_REFUSED;
  }
  const boardToken = credential.token;
  const repoToken = process.env.REPO_TOKEN ?? "";
  if (repoToken === "") {
    console.log(
      "::warning::UNMEASURED — REPO_TOKEN is empty, so no issue, branch or pull request " +
        "could be created. This is not a board reading. Nothing was created.",
    );
    return EXIT_REFUSED;
  }

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
    const { observed, waitExpired } = await awaitLane(boardToken, project, nodeId, s.expect, budgetMs);
    readings.push({ step: s, observed, verdict: stepVerdict(s, observed), waitExpired });
  };

  // What the run is doing right now, so a throw can be reported as "this act
  // died" rather than as a stack trace. Run `42092949455` is why: it failed
  // on `404 POST /issues` and printed Bun's trace, and the UNMEASURED verdict
  // written for exactly that case was never reached.
  let act = "resolve credentials";
  let abortedAt: string | undefined;
  const doing = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
    act = what;
    return await f();
  };

  try {
    // Rows 1 and 2 — A blocks B, then A closes and B should become Ready.
    const a = await doing("create issue A (the blocker)", () =>
      createIssue(repoToken, repo, `walkthrough ${stamp} A (blocker)`),
    );
    const b = await doing("create issue B (the blocked one)", () =>
      createIssue(repoToken, repo, `walkthrough ${stamp} B (blocked)`),
    );
    made.push(a, b);
    // **`issue_id` is the REST DATABASE id, and the number does not fail.**
    // Measured 2026-11-05 on two throwaway issues: `issue_id=1770` (a repo
    // number) returned 200 and linked issue #4; `issue_id=6229750699`
    // (#1770's database id) linked #1770. So the wrong value is accepted and
    // resolves to a DIFFERENT issue — the walk-through would have blocked B
    // on something unrelated, watched Ready not move, and reported the Ready
    // lane broken. A false reading from the instrument built to stop false
    // readings. Caught by `ai-review` on this pull request.
    await doing("link B as blocked by A", () =>
      rest(repoToken, "POST", `/repos/${repo}/issues/${b.number}/dependencies/blocked_by`, {
        issue_id: a.id,
      }),
    );
    await doing("read row 1", () => record(1, b.nodeId));

    // Row 7 — the negative control, read BEFORE A closes, while B's blocker
    // is still open. Sharing B is deliberate: a separate issue would let the
    // control pass against a board that treats the two differently for a
    // reason unrelated to blockers.
    await doing("read row 7 (the negative control)", () => record(7, b.nodeId));

    await doing("close A", () => closeIssue(repoToken, repo, a.number, "completed"));
    await doing("read row 2 (Ready)", () => record(2, b.nodeId));

    // Row 3 — In progress. Nothing writes it; expected RED.
    await doing("assign B", () =>
      rest(repoToken, "POST", `/repos/${repo}/issues/${b.number}/assignees`, { assignees: ["hornjason"] }),
    );
    await doing("read row 3 (In progress)", () => record(3, b.nodeId));

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
    await doing("create the throwaway branch and commit", () =>
      createBranchWithCommit(repoToken, repo, branch!, "main", scratch),
    );
    const pr = await doing("open the throwaway pull request", () =>
      rest(repoToken, "POST", `/repos/${repo}/pulls`, {
        title: `walkthrough ${stamp} — throwaway, auto-deleted`,
        head: branch,
        base: "main",
        body: `Fixes #${b.number}\n\nThrowaway pull request from the board walk-through. It deletes itself.`,
        draft: false,
      }),
    );
    prNumber = pr.number;
    await doing("read row 4 (In review)", () => record(4, b.nodeId));

    // Row 5 needs the merge to actually happen, and on THIS repository that
    // takes minutes rather than seconds: main requires the `test` and
    // `ai-review` checks with `enforce_admins` on, so the throwaway pull
    // request has to pass its own CI before anything may merge it. Asking
    // immediately is a guaranteed refusal, and a guaranteed refusal reported
    // as a Done-lane failure is a false reading.
    //
    // A PR that still cannot merge when the budget expires leaves row 5
    // reading against a lane that was never given an event, so the warning
    // says so rather than blaming the Done writer.
    act = "wait for the throwaway pull request to become mergeable";
    const mergeable = await awaitMergeable(repoToken, repo, prNumber!, mergeBudgetMs);
    let mergeBlocked: string | null = null;
    if (mergeable) {
      try {
        await doing("merge the throwaway pull request", () =>
          rest(repoToken, "PUT", `/repos/${repo}/pulls/${prNumber}/merge`, { merge_method: "squash" }),
        );
        mergedPr = true;
      } catch (e) {
        mergeBlocked = `the merge was refused: ${e}`;
      }
    } else {
      mergeBlocked =
        `the pull request never became mergeable inside ${mergeBudgetMs / 1000}s — main requires ` +
        `the \`test\` and \`ai-review\` checks, so this is CI duration and branch protection`;
    }
    // **A merge that did not happen is not a Done-lane failure.** Calling
    // `record` here would compare the lane against `Done` and emit FAIL,
    // naming the Done writer for an event it was never given — and the
    // warning saying otherwise would sit elsewhere in the log, where no
    // machine reads it. `ai-review` finding `04843009` on PR #1772.
    if (mergeBlocked === null) {
      await doing("read row 5 (Done)", () => record(5, b.nodeId));
    } else {
      readings.push(unmeasuredReading(byRow.get(5)!, mergeBlocked));
    }

    // Row 6 — a not_planned close. Nothing moves it out of the lanes today.
    const c = await doing("create issue C (the cancelled one)", () =>
      createIssue(repoToken, repo, `walkthrough ${stamp} C (cancelled)`),
    );
    made.push(c);
    await doing("close C as not_planned", () => closeIssue(repoToken, repo, c.number, "not_planned"));
    await doing("read row 6 (Cancelled)", () => record(6, c.nodeId));
  } catch (e) {
    // **The throw is caught here and nowhere else.** Letting it escape is
    // what run `42092949455` did, and the output was a Bun stack trace
    // instead of the instrument's own verdict — so a credential fault read
    // like a crash rather than like UNMEASURED.
    abortedAt = `${act} (${e})`;
    console.log(`::error::the walk-through died performing "${act}": ${e}`);
  } finally {
    // **In a `finally`.** A step that throws is the case most likely to
    // litter the tracker, and it is exactly the case a trailing cleanup call
    // misses. Each deletion is independently guarded so one failure does not
    // strand the rest.
    if (prNumber !== null && !mergedPr) {
      try {
        await rest(repoToken, "PATCH", `/repos/${repo}/pulls/${prNumber}`, { state: "closed" });
      } catch (e) {
        console.log(`::warning::could not close throwaway pull request #${prNumber}: ${e}`);
      }
    }
    // Only after a MERGE is the scratch file on main. An unmerged run never
    // put it there, and asking for it would 404 — which would read as a
    // cleanup failure for a file that was correctly absent.
    if (mergedPr) {
      try {
        await deleteScratchFromBase(repoToken, repo, scratch, "main");
      } catch (e) {
        console.log(
          `::warning::the throwaway commit ${scratch} is still on main (${e}). ` +
            `Delete it by hand — a later run will not be blocked by it, but it is litter.`,
        );
      }
    }
    if (branch !== null) {
      try {
        await deleteBranch(repoToken, repo, branch);
      } catch (e) {
        console.log(`::warning::could not delete throwaway branch ${branch}: ${e}`);
      }
    }
    // **`deleteIssue` needs repository ADMIN, and `GITHUB_TOKEN` can never
    // hold it** — the ceiling is `write`, at any `permissions:` setting.
    // Blocking `ai-review` finding on PR #1772: moving the repository acts
    // onto `GITHUB_TOKEN` fixed issue CREATION and broke issue DELETION, so
    // every run would strand three throwaway issues on the tracker.
    //
    // Closing as `not_planned` is damage control, not a fix. An OPEN
    // throwaway sits in the pickable set and someone picks it up; a closed
    // one is merely litter. But it is litter that lands in the cancellation
    // rate, which is the number the spec's whole Cancelled argument rests
    // on — so the warning says what is actually required rather than
    // leaving the next reader to infer "admin" from a 403 that will not say
    // so.
    for (const m of made) {
      try {
        await deleteIssue(repoToken, m.nodeId);
      } catch (e) {
        try {
          await closeIssue(repoToken, repo, m.number, "not_planned");
        } catch {
          /* the warning below is the report either way */
        }
        console.log(
          `::warning::could not DELETE throwaway issue #${m.number} (${e}). Closed it as ` +
            `not_planned instead; delete it by hand. GitHub's deleteIssue mutation requires ` +
            `the repository ADMIN role, which GITHUB_TOKEN cannot be granted at any ` +
            `permissions level — a self-cleaning walk-through needs an admin-capable PAT.`,
        );
      }
    }
  }

  for (const line of reportLines(readings)) console.log(line);
  const v = runVerdict(readings, abortedAt);
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
