#!/usr/bin/env bun
/**
 * `rungate intake` — run the registered intake sources and print each one's
 * reading (#2248).
 *
 * Before this, nothing outside `lib/intake-sources.ts` called
 * `mineObservedFailures`, so no command ran intake at all. Jason decided on
 * #1126 (2026-11-15) that each source runs on its own trigger: `fix-commits`
 * in CI on push to main with full history (#2233), `gate-refusals` at the end
 * of a ship run (#2234). Both call this.
 *
 * ADVISORY. A source that cannot be read here prints UNMEASURED with the
 * producer's own reason and the command still exits 0: a shallow clone or an
 * absent run store says nothing about the change that triggered the run, so
 * it must never turn that run red. UNMEASURED is printed, never a silent
 * zero, and the partial count of an unmeasured reading is never printed as
 * the reading (`AggregateIntakeReading` withholds `candidates` there for the
 * same reason). A bad argument is the only refusal.
 */
import { resolve } from "path";
import {
  INTAKE_SOURCES,
  defaultIntakeContext,
  mineObservedFailures,
  type IntakeContext,
} from "../lib/intake-sources";

/** A bad argument. The only non-zero exit: every reading exits 0. */
export const EXIT_REFUSED = 2;

const USAGE =
  "rungate intake [--project-root <dir>] [--source <id>] [--json]   " +
  `(sources: ${INTAKE_SOURCES.map(s => s.id).join(", ")}; advisory — an unreadable source prints UNMEASURED and exits 0)`;

/**
 * `deps.workStore` overrides the run store, so a test reads a fixture rather
 * than this machine's `~/.rungate`. Absent, `defaultIntakeContext` decides,
 * which reads `RUNGATE_WORK_DIR` through `lib/paths.ts`.
 */
export function main(argv: readonly string[], deps: { workStore?: string } = {}): number {
  let rootArg: string | undefined;
  let source: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--project-root" || a === "--source") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error(`intake: ${a} needs a value after it. Nothing was read.\n${USAGE}`);
        return EXIT_REFUSED;
      }
      if (a === "--project-root") rootArg = next;
      else source = next;
      i++;
    } else {
      console.error(`intake: unknown argument ${JSON.stringify(a)}. Nothing was read.\n${USAGE}`);
      return EXIT_REFUSED;
    }
  }

  const sources = source === undefined ? INTAKE_SOURCES : INTAKE_SOURCES.filter(s => s.id === source);
  if (sources.length === 0) {
    console.error(
      `intake: no source is named ${JSON.stringify(source)}. The registered sources are ` +
        `${INTAKE_SOURCES.map(s => s.id).join(", ")}. Nothing was read.`,
    );
    return EXIT_REFUSED;
  }

  const root = resolve(rootArg ?? process.cwd());
  const base = defaultIntakeContext(root);
  const ctx: IntakeContext = deps.workStore === undefined ? base : { ...base, workStore: deps.workStore };
  const reading = mineObservedFailures(ctx, sources);

  if (json) {
    console.log(JSON.stringify(reading, null, 2));
    return 0;
  }

  for (const s of sources) {
    const r = reading.bySource[s.id];
    if (r.reading === "MEASURED") {
      console.log(
        `${s.id}: MEASURED — ${r.candidates.length} candidate(s) from ${r.commitsScanned} unit(s) of history read`,
      );
    } else {
      console.log(`${s.id}: UNMEASURED — ${r.unmeasuredReasons.join("; ")}`);
    }
  }
  console.log(
    reading.reading === "MEASURED"
      ? `intake: MEASURED — ${reading.candidates.length} candidate(s) across ${sources.length} source(s)`
      : `intake: UNMEASURED — ${reading.unmeasuredReasons.length} reason(s) above; ` +
          `${reading.partialCandidates.length} candidate(s) came from the sources that could be read, and are not a reading`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
