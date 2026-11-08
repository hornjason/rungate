/**
 * The git-config isolation set, declared ONCE as data (#1001).
 *
 * ## Why this file exists rather than a second copy of a string
 *
 * `git` executes code out of its own configuration. `core.fsmonitor` is a
 * command git runs, `core.hooksPath` points at hooks git fires, and
 * `core.excludesFile` can make a file invisible to the reading that is
 * supposed to see it. So **running `git` in a directory someone else chose
 * means running whatever that directory's `.git/config` says**, and
 * converting a shell string to an argv does nothing about it.
 *
 * That was measured once, under #960/#965, in a scratch repository with one
 * planted untracked file (git 2.50.1):
 *
 * | poisoned key | written where | unisolated | isolated |
 * |---|---|---|---|
 * | `core.excludesFile` → a file listing the plant | `~/.gitconfig` | **plant INVISIBLE** | `?? planted.txt` |
 * | `core.excludesFile` → a file listing the plant | the checkout's `.git/config` | **plant INVISIBLE** | `?? planted.txt` |
 * | `core.fsmonitor` → a script touching a marker | `~/.gitconfig` | **marker written — git ran it** | not run |
 * | `core.hooksPath` → a dir with `post-index-change` | `~/.gitconfig` | **hook fired** | not fired |
 *
 * **The lesson was learned once and propagated nowhere.** It lived as a
 * single shell-prefix string inside `lib/scaffold/ai-review-step.ts`, so
 * `hooks/CommitEnforcement.hook.ts` — which runs `git -C <a path out of an
 * agent's reply text>` — could not reuse it even in principle: its call sites
 * are `execFileSync('git', […])` and a shell prefix is not an argv.
 *
 * One declaration, two projections. `gitIsolatedShellPrefix()` reproduces the
 * existing string exactly, so `AI_REVIEW_GIT_ISOLATED` is now derived rather
 * than spelled; `gitIsolatedArgs`/`gitIsolatedEnv` serve the `execFileSync`
 * callers. A second declaration of either is refused by
 * `test/git-isolation.test.ts`.
 *
 * ## Why env vars AND `-c`, which is not belt-and-braces
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_CONFIG_NOSYSTEM` neutralise
 * whole FILES, so they cover keys nobody thought to enumerate — but they do
 * not touch the checkout's own `.git/config`, which is inside the tree being
 * read. The `-c` flags are the only thing covering row two of the table, and
 * command scope outranks local scope. **Neither covers the other.**
 *
 * ## `safe.directory='*'` is load-bearing, not a loosening
 *
 * `actions/checkout` writes `safe.directory` for the workspace into the
 * GLOBAL config on every job. Neutralise the global file and that exception
 * goes with it, so wherever the working tree is owned by a different uid than
 * the process — containers, rootless self-hosted pools — `git` exits 128 with
 * *"detected dubious ownership"*. `safe.directory` is honoured only from
 * protected scopes (system, global, command), so `-c` restores it from the
 * one source the subject cannot write, and the checkout's `.git/config` still
 * cannot set it. Without it, isolation would be stricter than what it
 * replaces in a way that fails closed on **green** repositories.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **Config a caller passes deliberately.** These are defaults a caller
 *   prepends; anything added after them wins.
 * - **`git` subcommands that reach the network.** `fetch` with these env vars
 *   also discards a proxy, a CA bundle, or an `insteadOf` rewrite a
 *   self-hosted runner legitimately keeps in `~/.gitconfig`. That is a
 *   different trade-off and is why `buildRestoreScript` was left out of #960.
 * - **The repository's CONTENT.** Isolating config is not reviewing a tree.
 *
 * Issue: #1001. Refs #960, #965.
 */

/**
 * Env vars neutralising whole config FILES.
 *
 * `GIT_CONFIG_NOSYSTEM=1` is not redundant with `GIT_CONFIG_SYSTEM=/dev/null`
 * on every git version, so both are set.
 */
export const GIT_ISOLATION_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

/**
 * Keys overridden at COMMAND scope, which outranks the checkout's own
 * `.git/config` — the one scope the env vars above cannot reach.
 *
 * `core.fsmonitor` is set to the empty string rather than removed: an empty
 * value is how git spells "no fsmonitor", and there is no `-c` form that
 * unsets a key.
 */
export const GIT_ISOLATION_CONFIG: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["core.fsmonitor", ""],
  ["core.excludesFile", "/dev/null"],
  ["core.hooksPath", "/dev/null"],
  ["safe.directory", "*"],
] as const);

/**
 * Ambient variables that must be **removed**, as against the three above
 * which are **set**.
 *
 * Two families, one property: each lets whoever populated the environment
 * redirect or reconfigure a git call that named neither, and nothing
 * downstream can tell — the reading comes back clean, confident, and about
 * another tree or another config.
 *
 * - **Location.** `GIT_DIR` and friends outrank `-C <root>`'s discovery, so
 *   a reader pointed at one checkout reports on a different one.
 * - **`GIT_CONFIG*`,** matched as a PREFIX because the injection form is
 *   open-ended: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor
 *   GIT_CONFIG_VALUE_0=<command>` is config at command scope, and `KEY_<n>`
 *   has no last element to enumerate. `GIT_CONFIG_GLOBAL` and
 *   `GIT_CONFIG_SYSTEM` are in the family too: pointed at a file the
 *   caller wrote, they are the same attack spelled as a path.
 *
 * **The `-c` flags are not a substitute, and the prefix is not redundant
 * with them.** Measured on git 2.50.1: `-c core.fsmonitor=` DOES beat
 * `GIT_CONFIG_KEY_0=core.fsmonitor`, so command-scope flags win where they
 * overlap — but {@link GIT_ISOLATION_CONFIG} names four keys, and the
 * injection can name any key git has. Neither covers the other, which is
 * the same conclusion the env-vars-AND-`-c` section above reaches from the
 * other direction. Review of #1896 round 9.
 */
export const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
] as const;

/** The prefix form, so `KEY_0`…`KEY_<n>` needs no enumeration. */
export const GIT_AMBIENT_CONFIG_PREFIX = "GIT_CONFIG";

/**
 * Variables whose VALUE git executes as a command.
 *
 * These are here for consistency, and the argument is short: stripping
 * `GIT_CONFIG_*` already removes an injected `core.sshCommand`, `core.pager`
 * and `core.fsmonitor`. Anyone able to set `GIT_CONFIG_KEY_0` can set
 * `GIT_SSH_COMMAND`, so closing the config spelling of a route and leaving
 * the direct spelling open buys nothing — it only makes the registry look
 * complete. Review of #1896 round 10.
 *
 * **`GIT_SSH_COMMAND` has a real cost and it is accepted deliberately.** A
 * deploy-key setup that passes `ssh -i <key>` through the environment
 * rather than through `core.sshCommand` will fail to authenticate. In
 * `lib/spec-source.ts` — this registry's only remote-reaching consumer — a
 * failed fetch is recorded as `staleness` and the reading continues, so the
 * cost is a reported stale ref rather than a refusal or a wrong answer.
 * That is the direction this module is required to be wrong in.
 *
 * `GIT_EXTERNAL_DIFF` is listed despite being unreachable from the one call
 * that could run it: measured on git 2.50.1, `diff --quiet` short-circuits
 * before the external driver while a plain `diff` does invoke it (the
 * control). A registry that only covers today's call sites is the narrower
 * kind of denylist this whole round was about.
 */
export const GIT_EXEC_VARS = [
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_TEXTCONV_CACHE",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
] as const;

/**
 * `base` with both families removed, and NOTHING set.
 *
 * Separate from {@link gitIsolatedEnv} because the two halves have
 * different costs. Removing an ambient override can only restore git's
 * own defaults, so it is safe for a command that reaches a remote;
 * *setting* `GIT_CONFIG_GLOBAL=/dev/null` discards `credential.helper`
 * with everything else, which is why `gitCredentialEnv` exists. A caller
 * that must fetch wants this one alone.
 */
export function withoutAmbientGitOverrides(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of GIT_LOCATION_VARS) delete env[name];
  for (const name of GIT_EXEC_VARS) delete env[name];
  for (const name of Object.keys(env)) {
    if (name.startsWith(GIT_AMBIENT_CONFIG_PREFIX)) delete env[name];
  }
  return env;
}

/**
 * The shell-prefix projection: `VAR=… VAR=… git -c k=v …`, ready to be
 * interpolated in front of a subcommand in a generated script.
 *
 * `safe.directory`'s value is single-quoted because `*` would otherwise be
 * glob-expanded by the shell. That quoting is a property of THIS projection
 * and must not leak into the argv one, where the value is passed literally —
 * a `'*'` reaching git through `execFileSync` would be three characters that
 * match no directory, i.e. isolation that silently does not apply.
 */
export function gitIsolatedShellPrefix(): string {
  const env = Object.entries(GIT_ISOLATION_ENV).map(([k, v]) => `${k}=${v}`).join(" ");
  const flags = GIT_ISOLATION_CONFIG.map(([k, v]) => `-c ${k}=${shellQuoteIfGlob(v)}`).join(" ");
  return `${env} git ${flags}`;
}

/** Single-quote a value a shell would otherwise expand. */
function shellQuoteIfGlob(v: string): string {
  return /[*?[\]]/.test(v) ? `'${v}'` : v;
}

/**
 * The argv projection: the `-c` flags, followed by whatever the caller
 * passes.
 *
 * Pre-command options only, so a caller's own `-C <dir>` may follow in any
 * order. Pair with `gitIsolatedEnv`; the flags alone leave `~/.gitconfig`
 * live, and the env alone leaves the checkout's `.git/config` live.
 */
export function gitIsolatedArgs(args: readonly string[] = []): string[] {
  const flags: string[] = [];
  for (const [k, v] of GIT_ISOLATION_CONFIG) flags.push("-c", `${k}=${v}`);
  return [...flags, ...args];
}

/**
 * `base` with the isolation vars applied on top.
 *
 * Takes the base environment as a parameter rather than reading
 * `process.env`, so a case can drive it without touching the machine's.
 *
 * The strip happens HERE rather than being left to the caller to compose,
 * because the two steps are order-sensitive and only one order is safe:
 * stripping `GIT_CONFIG*` after setting it removes the isolation this
 * function exists to apply, and the result looks exactly like the
 * isolated case. Both halves are individually correct and the series is
 * not, so there is no composition for a caller to get wrong.
 */
export function gitIsolatedEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...withoutAmbientGitOverrides(base), ...GIT_ISOLATION_ENV };
}

/**
 * The environment for a git command that must reach a REMOTE.
 *
 * `gitIsolatedEnv` is right for reads: nulling the global and system config
 * makes a reading the same on every machine. It is wrong for `push` and
 * `ls-remote`, because `credential.helper` is declared in exactly those
 * files and removing them removes the credential.
 *
 * Measured 2026-10-31 on this machine, and it is every push rather than a
 * corner case: the only `credential.helper` is `osxkeychain`, declared in
 * the SYSTEM gitconfig at
 * `/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig`. Under
 * isolation `git push --dry-run` fails with *"could not read Username for
 * 'https://github.com'"*; run with this env it reports *"Everything
 * up-to-date"*.
 *
 * So this deliberately applies NO env isolation. Command-scope isolation
 * still applies through `gitIsolatedArgs`, which is where the determinism
 * that does not depend on credentials lives. It exists here, beside its
 * opposite, so a caller choosing between them is choosing between two named
 * things in the declaring position rather than hand-rolling an env object.
 *
 * `base` is copied rather than passed through, because a Bun child spawned
 * with no `env` key does not observe a late edit to `process.env` — which
 * would make this branch unreachable from any test that sets one.
 */
export function gitCredentialEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base };
}
