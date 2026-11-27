/**
 * feature-manifest.ts — the schema a consumer's feature manifest is written
 * in, and the validator that holds a manifest to the tree it describes
 * (ADR-028, #2888).
 *
 * A consumer's own adapter writes the manifest from what its code declares:
 * each feature's entry files, pages, routes and sources, and who consumes it.
 * Rungate never guesses those facts by name (ADR-028, decision 1); it derives
 * the generic layers from them later (files from the import graph, the proof
 * chain, churn).
 *
 * The validator answers one question: does every file, page and route the
 * manifest names exist in the tree? Its verdict has three values, because a
 * name that could not be checked has not passed (SUCCESS.md claim 4):
 *
 * - **refused**: the manifest is malformed, or names something the tree does
 *   not hold. Every reason is listed.
 * - **unmeasured**: nothing was refused, but something could not be checked:
 *   a file that could not be read, or pages or routes with no reading of the
 *   tree's own to compare against. Each is named.
 * - **valid**: everything named was checked and is there.
 *
 * The tree's pages and routes are a reading the caller supplies. Producing
 * them from every router is the code map's job (SC-2813, #2889).
 */
import { readdirSync, realpathSync } from "fs";
import { join, posix, relative, sep } from "path";
import { z } from "zod";

import { Presence } from "./path-probe";

/** The value of a manifest's `schema` field. A new version is a new literal, never a widening of this one. */
export const FEATURE_MANIFEST_VERSION = "rungate.feature-manifest/v1";

/** A feature, source or consumer name: what cards, links and agents refer to it by. */
const NAME = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.-]*$/u, "a name is letters, digits, '.', '_' or '-', starting with a letter or digit");

/** A path from the repository root, as the tree spells it. Whether it is in the tree is the validator's question, not the schema's. */
const REL_PATH = z.string().min(1);

/** An HTTP route: an upper-case method, one space, and a path starting with `/`. */
const ROUTE = z.string().regex(/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \/\S*$/, "a route is an upper-case method, one space, and a path starting with '/'");

const FEATURE = z
  .object({
    name: NAME,
    /** What the feature is supposed to do, in a sentence: the intended state a card shows. */
    summary: z.string().min(1),
    /** The files the feature starts from. Its other files are derived from their imports. */
    entryFiles: z.array(REL_PATH).min(1),
    /** Pages, as the router spells them, such as `/cases`. */
    pages: z.array(z.string().min(1)).default([]),
    routes: z.array(ROUTE).default([]),
    /** Names of entries in the manifest's `sources`. */
    sources: z.array(NAME).default([]),
    /** A read-only status endpoint. Without one, a card says "not measured" (ADR-028, decision 5). */
    statusEndpoint: z.string().url().optional(),
  })
  .strict();

/**
 * The manifest. Every object is strict: a key this version does not define
 * is refused, never ignored, so a misspelt field cannot read as absent.
 */
export const featureManifestSchema = z
  .object({
    schema: z.literal(FEATURE_MANIFEST_VERSION),
    /** The adapter command that wrote this manifest, so a staleness check can run it again. */
    generatedBy: z.string().min(1),
    features: z.array(FEATURE).min(1),
    /** Where data comes from, outside the code: an API, a file, a feed. */
    sources: z.array(z.object({ name: NAME, kind: z.string().min(1) }).strict()).default([]),
    /** What reads the features' output: a page, a job, another system. */
    consumers: z.array(z.object({ name: NAME, uses: z.array(NAME).min(1) }).strict()).default([]),
    /** Files, pages and routes that belong to no one feature, declared as shared. */
    shared: z
      .object({
        files: z.array(REL_PATH).default([]),
        pages: z.array(z.string().min(1)).default([]),
        routes: z.array(ROUTE).default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

export type FeatureManifest = z.infer<typeof featureManifestSchema>;

/**
 * What is at a path in the tree, as the caller read it. `spelled` is a file
 * the tree holds under a different spelling, which a case-insensitive file
 * system finds and a case-sensitive one does not (#2910 review); `outside` is
 * a file reached through a link that leaves the tree.
 */
export type FileReading =
  | { kind: "file" }
  | { kind: "other" }
  | { kind: "absent" }
  | { kind: "unread"; why: string }
  | { kind: "spelled"; as: string }
  | { kind: "outside" };

/** The tree a manifest is checked against. A missing `pages` or `routes` is a reading not taken, never an empty one. */
export interface TreeReading {
  fileAt(rel: string): FileReading;
  pages?: ReadonlySet<string>;
  routes?: ReadonlySet<string>;
}

/**
 * The tree at `root`, its files read through the one presence decider
 * (#2878), with the pages and routes the caller read from its routers. A
 * directory or FIFO where a file is named is `other`; a path that cannot be
 * followed or searched is `unread`, with the decider's reason.
 */
export function treeReading(root: string, read: { pages?: Iterable<string>; routes?: Iterable<string> } = {}): TreeReading {
  return {
    fileAt: rel => {
      let why = "";
      return Presence.decide(join(root, rel), "file", (_, w) => (why = w)).on<FileReading>({
        present: () => asSpelled(root, rel),
        // The decider names something of another kind and calls it absent;
        // it names nothing when nothing is there.
        absent: () => (why === "" ? { kind: "absent" } : { kind: "other" }),
        unread: () => ({ kind: "unread", why }),
      });
    },
    pages: read.pages === undefined ? undefined : new Set(read.pages),
    routes: read.routes === undefined ? undefined : new Set(read.routes),
  };
}

/**
 * A file the decider found, held to the tree's own spelling of every segment
 * and to the tree itself. A directory that cannot be listed, or a path that
 * cannot be resolved, is unread, never taken as the right spelling.
 */
function asSpelled(root: string, rel: string): FileReading {
  let dir = root;
  const actual: string[] = [];
  for (const seg of rel.split("/")) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      return { kind: "unread", why: (e as NodeJS.ErrnoException).code ?? String(e) };
    }
    const name = names.includes(seg) ? seg : names.find(n => n.toLowerCase() === seg.toLowerCase());
    if (name === undefined) return { kind: "absent" };
    actual.push(name);
    dir = join(dir, name);
  }
  if (actual.join("/") !== rel) return { kind: "spelled", as: actual.join("/") };
  try {
    const inside = relative(realpathSync(root), realpathSync(join(root, rel)));
    if (inside === ".." || inside.startsWith(`..${sep}`) || inside.startsWith(sep)) return { kind: "outside" };
  } catch (e) {
    return { kind: "unread", why: (e as NodeJS.ErrnoException).code ?? String(e) };
  }
  return { kind: "file" };
}

export type ManifestVerdict =
  | { verdict: "valid"; manifest: FeatureManifest }
  | { verdict: "unmeasured"; manifest: FeatureManifest; unmeasured: string[] }
  | { verdict: "refused"; refusals: string[]; unmeasured: string[] };

/** Why a path cannot name a file in the tree, or null when it can. */
function pathProblem(rel: string): string | null {
  if (/[\u0000-\u001f]/.test(rel)) return "holds a control character";
  if (rel.includes("\\")) return "uses a backslash; paths are written with '/'";
  if (rel.startsWith("/")) return "is absolute; paths are written from the repository root";
  if (posix.normalize(rel) !== rel || rel.endsWith("/")) return `is not written plainly; write it as '${posix.normalize(rel).replace(/\/$/, "")}'`;
  if (rel === ".." || rel.startsWith("../")) return "leaves the repository";
  return null;
}

/** The names in `list` that appear more than once, each once. */
function duplicates(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const n of list) (seen.has(n) ? twice : seen).add(n);
  return [...twice];
}

/**
 * Hold a parsed manifest value to the schema and to the tree. Every reason
 * is collected, so one run names every problem rather than the first.
 */
export function validateManifest(value: unknown, tree: TreeReading): ManifestVerdict {
  const parsed = featureManifestSchema.safeParse(value);
  if (!parsed.success) {
    const refusals = parsed.error.issues.map(i => `${i.path.length ? i.path.join(".") : "(the manifest)"}: ${i.message}`);
    return { verdict: "refused", refusals, unmeasured: [] };
  }
  const m = parsed.data;
  const refusals: string[] = [];
  const unmeasured: string[] = [];

  for (const [what, names] of [
    ["feature", m.features.map(f => f.name)],
    ["source", m.sources.map(s => s.name)],
    ["consumer", m.consumers.map(c => c.name)],
  ] as const) {
    for (const d of duplicates(names)) refusals.push(`${what} '${d}' is declared more than once`);
  }
  const features = new Set(m.features.map(f => f.name));
  const sources = new Set(m.sources.map(s => s.name));
  for (const f of m.features) for (const s of f.sources) if (!sources.has(s)) refusals.push(`feature '${f.name}' names source '${s}', which the manifest does not declare`);
  for (const c of m.consumers) for (const u of c.uses) if (!features.has(u)) refusals.push(`consumer '${c.name}' uses '${u}', which is not a feature`);

  const files: Array<[string, string]> = [
    ...m.features.flatMap(f => f.entryFiles.map(p => [`feature '${f.name}'`, p] as [string, string])),
    ...m.shared.files.map(p => ["shared", p] as [string, string]),
  ];
  for (const [owner, rel] of files) {
    const problem = pathProblem(rel);
    if (problem) {
      refusals.push(`${owner} file '${rel}' ${problem}`);
      continue;
    }
    const at = tree.fileAt(rel);
    if (at.kind === "absent") refusals.push(`${owner} names '${rel}', which the tree does not hold`);
    else if (at.kind === "other") refusals.push(`${owner} names '${rel}', which is not a file`);
    else if (at.kind === "unread") unmeasured.push(`${owner} file '${rel}' could not be read (${at.why})`);
    else if (at.kind === "spelled") refusals.push(`${owner} names '${rel}', which the tree spells '${at.as}'`);
    else if (at.kind === "outside") refusals.push(`${owner} names '${rel}', which leads outside the repository through a link`);
  }

  for (const [kind, held] of [
    ["page", tree.pages],
    ["route", tree.routes],
  ] as const) {
    const named: Array<[string, string]> = [
      ...m.features.flatMap(f => (kind === "page" ? f.pages : f.routes).map(n => [`feature '${f.name}'`, n] as [string, string])),
      ...(kind === "page" ? m.shared.pages : m.shared.routes).map(n => ["shared", n] as [string, string]),
    ];
    if (named.length === 0) continue;
    if (held === undefined) {
      unmeasured.push(`${named.length} ${kind}(s) not checked: no reading of the tree's ${kind}s was supplied`);
      continue;
    }
    for (const [owner, n] of named) if (!held.has(n)) refusals.push(`${owner} names ${kind} '${n}', which the tree does not hold`);
  }

  if (refusals.length) return { verdict: "refused", refusals, unmeasured };
  if (unmeasured.length) return { verdict: "unmeasured", manifest: m, unmeasured };
  return { verdict: "valid", manifest: m };
}

/** The same, from the manifest file's text. A leading byte-order mark is not part of the JSON. */
export function validateManifestText(text: string, tree: TreeReading): ManifestVerdict {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    return { verdict: "refused", refusals: [`the manifest is not JSON: ${(e as Error).message}`], unmeasured: [] };
  }
  return validateManifest(value, tree);
}
