/**
 * Covers CRC-B8 (CODE-REVIEW-CONVERGENCE-SPEC.md), #2832.
 *
 * Every finding is answered: fixed, or resolved with a stated reason. #1162
 * closed the half where a finding was silently dropped, because every round's
 * findings are now posted as review threads. This file is the other half. A
 * thread can be resolved with no reply, so a finding could leave without
 * anyone saying it was fixed or why it was not.
 *
 * From the next round on, the adjudicator reads every earlier finding thread
 * the carry step wrote. Any that no person has replied to refuses the round,
 * named. A reply is the stated reason: "fixed in <sha>" and "not fixing,
 * because ..." both count. A class thread is left to CRC-N7, whose reply must
 * also state the population, so one thread is never refused twice.
 *
 * What separates pass from fail: the same CLEAN payload exits 0 or refuses
 * depending only on whether the finding's thread has a reply from a person
 * (FA-8, FA-9). A mutant `findingsUnanswered` that counts a bot reply clears
 * FA-2. One that ignores the key marker reds FA-4. One that drops the
 * outcome override reds FA-8. The spawned script (FA-11) reds if the wrapper
 * stops passing the reading to `main`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { findingsUnansweredFromThreads } from "../lib/ai-review-suppression";
import {
  AI_REVIEW_FINDING_UNANSWERED_TITLE,
  AI_REVIEW_FINDING_UNANSWERED_UNMEASURED_TITLE,
  findingsUnanswered,
  main,
  threadBody,
} from "../lib/scaffold/ai-review-findings";
import { AI_REVIEW_OUTCOME_LINE, AI_REVIEW_REQUIRED_EXIT, AI_REVIEW_THREADS_PATH_VAR } from "../lib/scaffold/ai-review-step";

let SCRATCH = "";
beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ai-review-finding-answered-"));
});
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

const FINDING = {
  severity: "low",
  file: "lib/a.ts",
  line: 3,
  summary: "The retry loop never sleeps between attempts",
  failure_scenario: "a flaky endpoint is called five times in one millisecond",
};
const keyed = (summary = FINDING.summary, key = "k") => threadBody({ ...FINDING, summary }, key);

function captured(fn: () => number): { lines: string[]; code: number } {
  const out: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  let code: number;
  try {
    code = fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  return { lines: out.join("\n").split("\n"), code };
}

let seq = 0;
function cleanPayload(): string {
  const path = join(SCRATCH, `findings-${seq++}.json`);
  writeFileSync(path, JSON.stringify({ findings: [], verdict: "PASS" }));
  return path;
}

const unansweredOf = (r: ReturnType<typeof findingsUnanswered>): string[] => (r.status === "MEASURED" ? r.unanswered : ["<UNMEASURED>"]);

describe("CRC-B8 (#2832): which earlier finding threads are unanswered", () => {
  test("FA-1: a finding thread with no reply is unanswered, and named", () => {
    const r = findingsUnanswered([{ body: keyed(), replies: [] }]);
    expect(unansweredOf(r)).toHaveLength(1);
    expect(unansweredOf(r)[0]).toContain("The retry loop never sleeps between attempts");
  });

  test("FA-2: a bot's reply is not an answer", () => {
    const r = findingsUnanswered([{ body: keyed(), replies: [{ body: "Fixed in abc123.", bot: true }] }]);
    expect(unansweredOf(r)).toHaveLength(1);
  });

  test("FA-3: any reply from a person answers it, whatever it says", () => {
    for (const body of ["Fixed in abc123.", "Not fixing: the loop is bounded by the caller.", "ok"]) {
      expect(findingsUnanswered([{ body: keyed(), replies: [{ body, bot: false }] }]), body).toEqual({
        status: "MEASURED",
        unanswered: [],
      });
    }
  });

  test("FA-4: a thread that is not a posted finding is not this rule's", () => {
    // A person's own review comment carries no key marker.
    const human = "Could this use the shared retry helper?";
    expect(findingsUnanswered([{ body: human, replies: [] }])).toEqual({ status: "MEASURED", unanswered: [] });
    // A finding body written without a key is not a posted thread either.
    expect(findingsUnanswered([{ body: threadBody(FINDING), replies: [] }])).toEqual({ status: "MEASURED", unanswered: [] });
  });

  test("FA-5: a class thread is CRC-N7's, so it is not refused a second time here", () => {
    const classBody = threadBody({ ...FINDING, population: 4 }, "k");
    expect(findingsUnanswered([{ body: classBody, replies: [] }])).toEqual({ status: "MEASURED", unanswered: [] });
  });

  test("FA-6: a thread whose replies were not carried makes only itself unknown", () => {
    const unread = { body: keyed("Unread finding", "u"), replies: undefined };
    const owing = { body: keyed("Owing finding", "o"), replies: [] };
    const answered = { body: keyed("Answered finding", "a"), replies: [{ body: "done", bot: false }] };
    for (const list of [[unread, owing], [owing, unread]]) {
      const r = findingsUnanswered(list);
      expect(r.status).toBe("MEASURED");
      expect(unansweredOf(r).map(u => u.includes("Owing finding"))).toEqual([true]);
    }
    const mixed = findingsUnanswered([answered, unread]);
    expect(mixed.status).toBe("UNMEASURED");
    expect(mixed.status === "UNMEASURED" ? mixed.reason : "").toContain("1 of 2");
  });

  test("FA-7: read from the bytes the carry step writes", () => {
    const owing = JSON.stringify([{ isResolved: true, body: keyed(), replies: [] }]);
    const answered = JSON.stringify([{ isResolved: true, body: keyed(), replies: [{ body: "fixed", bot: false }] }]);
    const older = JSON.stringify([{ isResolved: false, body: keyed() }]);
    expect(unansweredOf(findingsUnansweredFromThreads(owing))).toHaveLength(1);
    expect(findingsUnansweredFromThreads(answered)).toEqual({ status: "MEASURED", unanswered: [] });
    expect(findingsUnansweredFromThreads(older).status).toBe("UNMEASURED");
    expect(findingsUnansweredFromThreads(null).status).toBe("UNMEASURED");
    expect(findingsUnansweredFromThreads("{ not json").status).toBe("UNMEASURED");
  });
});

describe("CRC-B8 (#2832): the adjudicator refuses while a finding is unanswered", () => {
  test("FA-8: a clean payload refuses while an earlier finding has no reply, and names it", () => {
    const unanswered = findingsUnanswered([{ body: keyed(), replies: [] }]);
    const r = captured(() => main([cleanPayload()], null, null, null, undefined, null, unanswered));
    expect(r.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(r.lines).toContain(`${AI_REVIEW_OUTCOME_LINE} BLOCKED`);
    const error = r.lines.find(l => l.startsWith(`::error title=${AI_REVIEW_FINDING_UNANSWERED_TITLE}::`));
    expect(error).toBeDefined();
    expect(error).toContain("The retry loop never sleeps between attempts");
  });

  test("FA-9: the same payload passes once a person replies", () => {
    const unanswered = findingsUnanswered([{ body: keyed(), replies: [{ body: "Fixed in abc123.", bot: false }] }]);
    const r = captured(() => main([cleanPayload()], null, null, null, undefined, null, unanswered));
    expect(r.code).toBe(0);
    expect(r.lines).toContain(`${AI_REVIEW_OUTCOME_LINE} CLEAN`);
    expect(r.lines.some(l => l.includes(AI_REVIEW_FINDING_UNANSWERED_TITLE))).toBe(false);
  });

  test("FA-10: replies that were not carried pass with a named warning, not a refusal", () => {
    const unanswered = findingsUnanswered([{ body: keyed(), replies: undefined }]);
    const r = captured(() => main([cleanPayload()], null, null, null, undefined, null, unanswered));
    expect(r.code).toBe(0);
    expect(r.lines.some(l => l.startsWith(`::warning title=${AI_REVIEW_FINDING_UNANSWERED_UNMEASURED_TITLE}::`) && l.includes("UNMEASURED"))).toBe(
      true,
    );
  });

  test("FA-11: the command CI runs reads the carried thread list and refuses on it", async () => {
    const threads = join(SCRATCH, "threads.json");
    writeFileSync(threads, JSON.stringify([{ isResolved: true, body: keyed(), replies: [] }]));
    const run = async (file: string) => {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "scripts", "ai-review-findings.ts"), cleanPayload()], {
        cwd: SCRATCH,
        env: { ...process.env, [AI_REVIEW_THREADS_PATH_VAR]: file },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { text: `${out}\n${err}`, code };
    };
    const blocked = await run(threads);
    expect(blocked.text).toContain(`${AI_REVIEW_OUTCOME_LINE} BLOCKED`);
    expect(blocked.text).toContain(AI_REVIEW_FINDING_UNANSWERED_TITLE);
    expect(blocked.code).toBe(AI_REVIEW_REQUIRED_EXIT);

    writeFileSync(threads, JSON.stringify([{ isResolved: true, body: keyed(), replies: [{ body: "fixed", bot: false }] }]));
    const cleared = await run(threads);
    expect(cleared.text).toContain(`${AI_REVIEW_OUTCOME_LINE} CLEAN`);
    expect(cleared.code).toBe(0);
  });
});
