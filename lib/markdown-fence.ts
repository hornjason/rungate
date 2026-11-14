/**
 * Is this line inside a fenced code block? The one answer for lib/. #2130.
 *
 * ## Why one module
 *
 * Seven readers in lib/ answered this four different ways. One closed a ```
 * block on a `~~~` line. One let a ```` block close on its first ``` content
 * line. One missed a longer close, so its block ran on. The cost each time
 * was the same: a `# heading`, a path or a `Fixes #N` written inside an
 * example was read as real. Found in review round 2 of #2127, where
 * `finding-promotion` read a fenced heading and misplaced a criterion.
 *
 * Seven deciders of one grammar is the "two deciders that agree" shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, and a behavioural suite
 * only catches the last one to regress. So `test/markdown-fence.test.ts`
 * holds a census that fails on any other lib/ file spelling a fence regex.
 *
 * ## The grammar, CommonMark's
 *
 * - A fence opens on a run of three or more backticks, or three or more
 *   tildes. What follows the run is the info string.
 * - It closes only on a run of the SAME character, at least as long, with
 *   nothing after it but whitespace. A ``` line inside a `~~~` block is
 *   content; so is ```` ```js ```` inside a ```` ```md ```` block.
 * - An unclosed fence runs to the end of the text, which is how a renderer
 *   shows it, and `readFences` says where it opened so a caller can refuse
 *   rather than silently treat the rest as code.
 *
 * ## Two deliberate departures, both inherited from every reader before this
 *
 * - **Any indentation opens.** CommonMark allows three spaces, but a fence
 *   inside a list item is indented by the item's content offset, and a line
 *   reader cannot see list containers. Every site but one read any
 *   indentation already. `lib/filing-plan.ts` applies the three-space limit
 *   itself, because it also handles indented code blocks.
 * - **A backtick info string may contain backticks.** CommonMark would not
 *   open on ```` ```a`b ````. Every reader here did, and `lib/filing-plan.ts`
 *   relies on it to resolve an ambiguous line toward NOT authorising.
 */

export type FenceChar = "`" | "~";

/** A line that opens a fence: its marker, the info string after it, and its indentation. */
export interface FenceOpening {
  readonly char: FenceChar;
  readonly length: number;
  /** Everything after the marker run, untrimmed. */
  readonly info: string;
  /** Spaces and tabs before the marker run. */
  readonly indent: number;
}

/** The one spelling of a fence marker line in lib/. */
const MARKER_LINE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

/** The fence `line` would open, or `null` when it is not a fence line. */
export function fenceOpening(line: string): FenceOpening | null {
  const m = MARKER_LINE.exec(line);
  if (m === null) return null;
  return { char: m[2]![0] as FenceChar, length: m[2]!.length, info: m[3]!, indent: m[1]!.length };
}

/** Whether `line` closes the fence `open` opened: same character, at least as long, nothing after. */
export function closesFence(line: string, open: FenceOpening): boolean {
  const m = fenceOpening(line);
  return m !== null && m.char === open.char && m.length >= open.length && m.info.trim() === "";
}

/** `fence` is an opening or closing marker line; `code` is a line between them. */
export type LineRole = "prose" | "fence" | "code";

export interface FenceReading {
  /** One role per input line. */
  readonly roles: readonly LineRole[];
  /** The index of the line that opened a fence nothing closed, or `null`. */
  readonly unclosedAt: number | null;
}

/** Every line's role. An unclosed fence marks the rest `code` and is reported by `unclosedAt`. */
export function readFences(lines: readonly string[]): FenceReading {
  const roles: LineRole[] = [];
  let open: FenceOpening | null = null;
  let openedAt: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (open === null) {
      open = fenceOpening(line);
      if (open === null) {
        roles.push("prose");
        continue;
      }
      openedAt = i;
      roles.push("fence");
      continue;
    }
    if (closesFence(line, open)) {
      open = null;
      openedAt = null;
      roles.push("fence");
      continue;
    }
    roles.push("code");
  }
  return { roles, unclosedAt: openedAt };
}

/**
 * Each fenced block's character range in `text`, from the start of its
 * opening line to the end of its closing line — or to the end of the text,
 * for an unclosed one. For a caller that masks by offset rather than by line.
 */
export function fencedBlocks(text: string): { start: number; end: number }[] {
  const lines = text.split("\n");
  const { roles } = readFences(lines);
  const out: { start: number; end: number }[] = [];
  let offset = 0;
  let current: { start: number; end: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const end = offset + lines[i]!.length;
    const opening = roles[i] === "fence" && (i === 0 || roles[i - 1] === "prose" || current === null);
    if (roles[i] === "prose") {
      current = null;
    } else if (opening) {
      current = { start: offset, end };
      out.push(current);
    } else {
      current!.end = end;
      // A closing marker ends the block, so the next marker line opens another.
      if (roles[i] === "fence") current = null;
    }
    offset = end + 1;
  }
  return out;
}
