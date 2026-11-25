#!/usr/bin/env bun
/**
 * The `rungate` command (#363).
 *
 * `AGENTS.md` published `bunx rungate create-spec` to every scaffolded
 * project and `package.json` declared no `bin`, so the documented consumer
 * interface did not exist. This is it.
 *
 * Deliberately thin: the command table is `lib/cli-commands.ts`, so the three
 * things that must agree — what dispatches, what ships, what the generator
 * publishes — read from one place instead of three.
 */
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { CLI_COMMANDS, UNKNOWN_COMMAND_EXIT, helpText, runCommandScript } from "../lib/cli-commands";
import { harnessVersionLine } from "../lib/harness-identity";
import { INCOMPLETE_INSTALL_EXIT, incompleteInstallMessage, missingDependencies } from "../lib/install-integrity";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Say which version is running, before anything else can fail.
//
// On STDERR, and that is the whole design. `ai-review.yml` captures the
// adjudicator with `2>&1`, so this reaches the CI log either way and nothing
// is lost by keeping it off stdout — while stdout stays what a caller can
// parse. `--version` in particular exists to be read by a machine and must
// remain exactly one line.
//
// Emitted for every invocation including `--help` and an unknown command: the
// runs worth attributing are the ones that went wrong, and a banner that
// skips the failure paths is absent exactly when it is wanted.
console.error(harnessVersionLine(PACKAGE_ROOT));

const [name, ...rest] = process.argv.slice(2);

if (!name || name === "--help" || name === "-h" || name === "help") {
  console.log(helpText());
  process.exit(name ? 0 : 1);
}

if (name === "--version" || name === "-v") {
  const pkg = await import(join(PACKAGE_ROOT, "package.json"), { with: { type: "json" } });
  console.log((pkg.default ?? pkg).version);
  process.exit(0);
}

// Own keys only (#2677 round 1). The registry is an object literal, so a bare
// lookup also finds what every object inherits: `rungate constructor` read the
// Object function, skipped the branch below and crashed with exit 1.
const command = Object.hasOwn(CLI_COMMANDS, name) ? CLI_COMMANDS[name] : undefined;
if (!command) {
  console.error(`rungate: unknown command "${name}"\n`);
  console.error(helpText());
  // Its own status (#2676), so a workflow can tell a missing command from a
  // refusal (1) or a broken install without reading the sentence above.
  process.exit(UNKNOWN_COMMAND_EXIT);
}

// `rungate <command> --help` prints the command's registry entry and runs
// nothing (#2834). Each script used to decide what `--help` meant, and
// `create-spec` took it as a spec title and wrote `specs/HELP-SPEC.md` into
// the consumer's repository. Answered before the install check, so a command's
// help works from an install that cannot load a dependency, as `--help` does.
if (rest.some(a => a === "--help" || a === "-h")) {
  console.log(`rungate ${name} — ${command.summary}\n\nUsage: ${command.usage}`);
  process.exit(0);
}

// #2479: a half-written install crashes inside the script on a missing
// module, naming a temp path. Asked here, after the command is known and
// before it runs, so `--version`, `--help` and an unknown command still work
// from an install that cannot load a dependency.
//
// The command's own script is part of the same check (review round 4 of
// #2491). A missing script is either the race that half-writes everything
// else, or the packaging bug #363 is about, and from inside one install the
// two look identical. So it is reported with the dependencies, through the
// one refusal, and the packaging cause is named after the race.
const script = join(PACKAGE_ROOT, command.script);
const missing = missingDependencies(PACKAGE_ROOT);
const scriptMissing = !existsSync(script);
if (scriptMissing) missing.push(command.script);
if (missing.length > 0) {
  console.error(incompleteInstallMessage(PACKAGE_ROOT, missing));
  if (scriptMissing) {
    console.error(
      `If a re-run still cannot find ${command.script}, "${name}" is registered but the ` +
        `package's "files" field leaves it out — see test/cli-contract.test.ts, which exists to stop this.`,
    );
  }
  process.exit(INCOMPLETE_INSTALL_EXIT);
}

// Default the project root to where the USER is, not to where the package
// is. `scripts/create-spec.ts` ends with
// `const root = projectRoot ?? join(import.meta.dir, "..")` — right for
// `bun scripts/create-spec.ts` in this repo, and wrong for every consumer:
// `bunx rungate create-spec "Title"` would write into
// `node_modules/rungate/specs/` and print `Created specs/TITLE-SPEC.md`, so
// the command reports success and the consumer's project is untouched.
// Only added when the caller did not say otherwise, and only for commands
// that accept the flag — a script that does not would read it as a
// positional argument.
// Either spelling counts as the caller saying so: `--project-root=<dir>` read
// as absent appended the cwd AFTER it, and a last-one-wins reader then took
// the cwd over the directory the caller named (review of #2365).
const givesRoot = rest.some(a => a === "--project-root" || a.startsWith("--project-root="));
const needsRoot = command.projectRootFlag && !givesRoot;
const args = needsRoot ? [...rest, "--project-root", process.cwd()] : rest;

// Run the script as an ENTRY MODULE, so `import.meta.main` is true inside it
// and it sees its own arguments rather than the subcommand name.
//
// This was `process.argv = [...]; await import(script)`, and the argv rewrite
// was the tell: it existed to make an imported module look like an entry
// module, which is most of the way to just running it as one. The half it
// could not fake is `import.meta.main`, which is false for any dynamic
// import — so the three command scripts that guard on it loaded, ran nothing
// and exited 0. `lib/cli-commands.ts` carries the measurement.
process.exit(runCommandScript(script, args).code);
