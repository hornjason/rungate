/**
 * A JavaScript body's call structure, read by a parser (#2702).
 *
 * `lib/bash-write-guard.ts` asks, for a protected name inside an interpreter
 * body, whether any call holding it is a write. Until #2702 it answered from
 * a lexical mask (`codeMask`): quotes, `#` comments, JavaScript comments and
 * regex literals guessed character by character, in four readings. Each
 * review of #2699 found another JavaScript form the guess misread — a `//`
 * comment, a regex after `return`, `o .in / 2` — and a misread switched the
 * reader off for that body. A parser does not guess: acorn reads comments,
 * regex literals and template literals as the language does.
 *
 * Only a body that parses as JavaScript is read here; `readJsCalls` returns
 * null for anything else (Python, shell, a body whose quotes never close).
 * The guard reads every body with its mask as well, and refuses what either
 * reading finds: parsing is not knowing the language. Python's
 * `d: str = '/x/workflow-state.json'` parses as a JavaScript label and an
 * assignment to `str`, so this reading binds the wrong name, and only the
 * mask sees the copy onto `d`.
 *
 * Kept apart from the guard so the guard's mutation batteries, which copy it
 * into a scratch directory, carry one more file rather than the parser's
 * internals.
 */
import { parse } from 'acorn';

/** An acorn node, loosely: enough to walk without depending on acorn's types. */
interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface JsCallReading {
  /**
   * The text of every call or `new` whose ARGUMENTS hold offset `at`,
   * innermost first: callee, argument list, and any method chain called on
   * its result (`.write(…)` after `createWriteStream(…)`).
   */
  enclosingCalls(at: number): string[];
  /**
   * The identifier a string literal holding `[at, end)` is assigned to, or
   * null. The literal must END at the name, or for a directory name (`…/`) at
   * a file name after it, and hold no newline: the variable then holds the
   * path, not text that mentions it. A template literal's text between its
   * values counts as a literal (#2714). The value flows to the variable
   * through `+`, `||`, `??`, either branch of `?:`, and the arguments of a
   * path-building call (`join`, `resolve`, `normalize`, bare or as a member).
   */
  boundIdentifier(at: number, end: number): string | null;
  /** The offsets of every use of `name`: not its declaration, not a property spelled the same. */
  references(name: string): number[];
}

const OPTIONS = {
  ecmaVersion: 'latest',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
} as const;

function parseJs(body: string): AstNode | null {
  for (const sourceType of ['script', 'module'] as const) {
    try {
      return parse(body, { ...OPTIONS, sourceType }) as unknown as AstNode;
    } catch {
      // Not JavaScript in this mode; the other mode, then null. A body that
      // parses in neither is the guard's mask's to read, not a pass.
    }
  }
  return null;
}

function isNode(v: unknown): v is AstNode {
  return typeof v === 'object' && v !== null && typeof (v as AstNode).type === 'string';
}

/**
 * Every node with its parent, in source order. An explicit stack, not
 * recursion: acorn builds a left-deep tree for a long `+` chain without
 * recursing per term, and a recursive walk of 50,000 terms overflowed the
 * call stack, so the guard refused a read-only command (#2702 review).
 */
function walk(root: AstNode): Array<{ node: AstNode; parent: AstNode | null }> {
  const out: Array<{ node: AstNode; parent: AstNode | null }> = [];
  const stack: Array<{ node: AstNode; parent: AstNode | null }> = [{ node: root, parent: null }];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    out.push(entry);
    const children: AstNode[] = [];
    for (const [key, value] of Object.entries(entry.node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) {
        for (const v of value) if (isNode(v)) children.push(v);
      } else if (isNode(value)) children.push(value);
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], parent: entry.node });
  }
  return out;
}

function isStringLiteral(n: AstNode): boolean {
  if (n.type === 'Literal') return typeof n.value === 'string';
  return n.type === 'TemplateLiteral' && (n.expressions as unknown[]).length === 0;
}

/** A call that builds a path from its arguments: `join`, `resolve` or `normalize`, bare or as a member (#2714). */
const PATH_BUILDERS = new Set(['join', 'resolve', 'normalize']);
function buildsPath(call: AstNode): boolean {
  const callee = call.callee as AstNode;
  if (callee.type === 'Identifier') return PATH_BUILDERS.has(callee.name as string);
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  const prop = callee.property as AstNode;
  return prop.type === 'Identifier' && PATH_BUILDERS.has(prop.name as string);
}

/**
 * Whether `parent`'s value can be `child`'s, so a name `child` holds is in
 * what `parent` holds (#2714): either operand of `+`, either side of `||`
 * or `??`, the right side of `&&`, either branch of `?:` but never its test,
 * and any argument of a path-building call.
 */
function carriesValue(parent: AstNode, child: AstNode): boolean {
  switch (parent.type) {
    case 'BinaryExpression':
      return parent.operator === '+';
    case 'LogicalExpression':
      // `ok && '…'` holds the literal whenever `ok` is truthy (#2718 review).
      // Only the right side: a truthy literal on the left is never the value
      // of `'…' && x` (#2718 review round 3).
      if (parent.operator === '&&') return parent.right === child;
      return parent.operator === '||' || parent.operator === '??';
    case 'ConditionalExpression':
      return parent.consequent === child || parent.alternate === child;
    case 'CallExpression':
      return buildsPath(parent) && (parent.arguments as AstNode[]).includes(child);
    // `path?.join(…)`: acorn wraps an optional chain, and the wrapper's value
    // is the call's (#2718 review).
    case 'ChainExpression':
      return parent.expression === child;
    default:
      return false;
  }
}

function literalValue(n: AstNode): string {
  if (n.type === 'Literal') return n.value as string;
  const quasis = n.quasis as Array<{ value: { cooked: string | null } }>;
  return quasis[0]?.value.cooked ?? '';
}

export function readJsCalls(body: string): JsCallReading | null {
  const root = parseJs(body);
  if (root === null) return null;
  const nodes = walk(root);
  const parentOf = new Map<AstNode, AstNode | null>(nodes.map(({ node, parent }) => [node, parent]));
  const calls = nodes.map(e => e.node).filter(n => n.type === 'CallExpression' || n.type === 'NewExpression');

  const chainTop = (call: AstNode): AstNode => {
    let cur = call;
    for (;;) {
      const member = parentOf.get(cur);
      if (!member || member.type !== 'MemberExpression' || member.object !== cur) return cur;
      const next = parentOf.get(member);
      if (!next || next.type !== 'CallExpression' || next.callee !== member) return cur;
      cur = next;
    }
  };

  return {
    enclosingCalls(at: number): string[] {
      return calls
        .filter(c => (c.arguments as AstNode[]).some(a => a.start <= at && at < a.end))
        .sort((a, b) => a.end - a.start - (b.end - b.start))
        .map(c => body.slice(c.start, chainTop(c).end));
    },

    boundIdentifier(at: number, end: number): string | null {
      // A string literal holding the name, or one stretch of a template
      // literal's text, `${R}/witnesses/${f}` (#2714).
      const piece = nodes
        .map(e => e.node)
        .find(n =>
          (n.type === 'Literal' && typeof n.value === 'string' && n.start < at && end < n.end) ||
          (n.type === 'TemplateElement' && n.start <= at && end <= n.end));
      if (!piece) return null;
      const textEnd = piece.type === 'Literal' ? piece.end - 1 : piece.end;
      const name = body.slice(at, end);
      const tail = body.slice(end, textEnd);
      if (tail !== '' && !(name.endsWith('/') && /^[\w.\-/]+$/.test(tail))) return null;
      const text = piece.type === 'Literal' ? (piece.value as string) : body.slice(piece.start, piece.end);
      if (text.includes('\n')) return null;
      let top = piece.type === 'Literal' ? piece : parentOf.get(piece);
      if (!top) return null;
      for (;;) {
        const p = parentOf.get(top);
        if (p && carriesValue(p, top)) top = p;
        else break;
      }
      const holder = parentOf.get(top);
      if (!holder) return null;
      const id =
        holder.type === 'VariableDeclarator' && holder.init === top ? (holder.id as AstNode)
        : holder.type === 'AssignmentExpression' && holder.right === top ? (holder.left as AstNode)
        : holder.type === 'AssignmentPattern' && holder.right === top ? (holder.left as AstNode)
        : null;
      return id && id.type === 'Identifier' ? (id.name as string) : null;
    },

    references(name: string): number[] {
      return nodes
        .filter(({ node, parent }) => {
          if (node.type !== 'Identifier' || node.name !== name) return false;
          if (!parent) return true;
          if (parent.type === 'VariableDeclarator' && parent.id === node) return false;
          if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return false;
          if (parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return false;
          return true;
        })
        .map(({ node }) => node.start);
    },
  };
}
