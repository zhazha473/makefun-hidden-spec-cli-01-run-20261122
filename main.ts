// mend: one patch tool for every AI edit format, as SPEC.md specifies.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// the V4A patch format, JSON edits), finds the lines each edit names at the first
// of three matching tiers, and writes every change or none, printing what it
// changed or why it failed. Sections 5 to 8 (three-tier line matching, unified
// diffs, SEARCH/REPLACE blocks, V4A patches) and the move output line
// (`R <old> -> <new>`) are implemented here; sections 1 to 4, 9 and 10 follow the
// kit starter's shape.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split into its lines, its own line break, and whether it ends with one. */
interface FileParts {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { lines, br, fin };
}

function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.fin ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful move edit made, as [old, new] pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---- Section 5: matching lines ---- */

/** A line as a tier sees it: exact, trailing whitespace gone, or both ends gone. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  const want = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normLine(fileLines[i + k]!, tier) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/**
 * The first tier at which O occurs at or after `from` (tier 0 only when strict),
 * with every occurrence there; for an end-of-file chunk only occurrences that end
 * at the file's last line count. Null when O occurs at no tier.
 */
function findTier(
  fileLines: string[],
  o: string[],
  from: number,
  strict: boolean,
  eofOnly: boolean,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let ps = occurrencesAt(fileLines, o, t, from);
    if (eofOnly) ps = ps.filter((p) => p + o.length === fileLines.length);
    if (ps.length > 0) return { tier: t, pos: ps };
  }
  return null;
}

/** The first line at or after `from` equal to a one-line anchor, at the first tier with one. */
function findAnchorLine(fileLines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = from; i < fileLines.length; i++) {
      if (normLine(fileLines[i]!, t) === want) return i;
    }
  }
  return null;
}

/** One line of N: `ctx` is its index in O when it is a context line, else -1. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * N as it is written over the matched lines at `pos`: a context line is the
 * file's own matched line; at tier 2 every other non-blank line is re-indented,
 * its leading whitespace P (from O's first line) replaced by F (from the file's
 * first matched line); at tiers 0 and 1 the lines are written as they are.
 */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2) {
    f = /^[ \t]*/.exec(fileLines[pos]!)![0];
    p = /^[ \t]*/.exec(o[0]!)![0];
  }
  for (const nl of n) {
    if (nl.ctx >= 0) {
      out.push(fileLines[pos + nl.ctx]!);
      continue;
    }
    if (tier === 2) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/** A hunk or chunk body as its O lines and its N lines (with context marks). */
function bodyON(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) continue;
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkEndNoBreak(body: string[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    const l = body[j]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') last = j;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.startsWith('\\');
}

/* ---- Section 4: detecting the format ---- */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---- Section 6: unified diffs ---- */

interface Hunk {
  a: number;
  body: string[];
  o: string[];
  n: NLine[];
  endNoBreak: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  /** A `---`/`+++` pair named the paths, so `rename from`/`rename to` lines do not. */
  pairPaths: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;

/** A `--- ` or `+++ ` line's path, or null for `/dev/null`. */
function diffPathOrNull(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** Apply a section's hunks in order to a file's text; `path` is named on failure. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const wasEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...h.n.map((nl) => nl.text));
      if (wasEnd) f.fin = !h.endNoBreak;
      d += h.n.length;
      continue;
    }
    const found = findTier(f.lines, h.o, 0, strict, false);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const rep = buildReplacement(f.lines, best, h.o, h.n, found.tier);
    const runsToEnd = best + h.o.length === f.lines.length;
    f.lines = [...f.lines.slice(0, best), ...rep, ...f.lines.slice(best + h.o.length)];
    if (runsToEnd) f.fin = !h.endNoBreak;
    d += h.n.length - h.o.length;
  }
  return joinFile(f);
}

/** Whether a created file ends without a line break: a `\` follows its last `+` line. */
function creationEndNoBreak(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    let lastPlus = -1;
    for (let j = 0; j < body.length; j++) {
      if (body[j]![0] === '+') lastPlus = j;
    }
    if (lastPlus >= 0) return body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  }
  return false;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    if (sec.oldPath !== null && !safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
    if (sec.newPath !== null && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
    const isCreate = sec.newFile || sec.oldPath === null;
    const isDelete = !isCreate && (sec.deletedFile || sec.newPath === null);
    if (isCreate) {
      const np = sec.newPath;
      if (np === null) return;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const nl of h.n) if (nl.ctx < 0) plus.push(nl.text);
      }
      const endNoBreak = creationEndNoBreak(sec.hunks);
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (endNoBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = sec.oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = sec.oldPath!;
    const np = sec.newPath!;
    if (op !== np) {
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(tree.get(op)!, sec.hunks, strict, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
      return;
    }
    if (tree.get(op) === null) throw new Fail('missing', op);
    tree.now.set(op, applyHunks(tree.get(op)!, sec.hunks, strict, op));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, pairPaths: false, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.oldPath = diffPathOrNull(l);
        cur.newPath = diffPathOrNull(lines[i + 1]!);
        cur.pairPaths = true;
        i += 2;
        continue;
      }
      cur = { oldPath: diffPathOrNull(l), newPath: diffPathOrNull(lines[i + 1]!), pairPaths: true, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const { o, n } = bodyON(body);
      cur.hunks.push({ a, body, o, n, endNoBreak: hunkEndNoBreak(body) });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        if (!cur.pairPaths) cur.oldPath = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!cur.pairPaths) cur.newPath = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newFile = true;
        cur.deletedFile = false;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        cur.newFile = false;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitFile(text);
    const found = findTier(f.lines, oldLines, 0, strict, false);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const rep = buildReplacement(f.lines, pos, oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), found.tier);
    f.lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/* ---- Section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
  o: string[];
  n: NLine[];
}

function v4aEdit(
  kind: string,
  path: string,
  headerNum: number,
  secLines: { text: string; num: number }[],
  strict: boolean,
): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const { text, num } of secLines) {
      if (text.startsWith('+')) fileLines.push(text.slice(1));
      else if (text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${num}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (const { num } of secLines) throw new Exit2(`error: parse ${num}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
    moveTo = secLines[0]!.text.slice(13).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (let k = idx; k < secLines.length; k++) {
    const { text, num } = secLines[k]!;
    if (text.startsWith('@@')) {
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [], o: [], n: [] };
      chunks.push(cur);
    } else if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${num}`);
      cur.eof = true;
      cur = null;
    } else if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${num}`);
        cur = { anchor: null, eof: false, body: [], o: [], n: [] };
        chunks.push(cur);
      }
      cur.body.push(text);
    } else {
      throw new Exit2(`error: parse ${num}`);
    }
  }
  for (const ch of chunks) {
    const { o, n } = bodyON(ch.body);
    ch.o = o;
    ch.n = n;
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNum}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchorLine(f.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const ins = ch.n.map((nl) => nl.text);
        f.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
      } else {
        const found = findTier(f.lines, ch.o, cursor, strict, ch.eof);
        if (!found) throw new Fail('no-match', path);
        const pos = found.pos[0]!;
        const rep = buildReplacement(f.lines, pos, ch.o, ch.n, found.tier);
        f.lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + ch.o.length)];
        cursor = pos + rep.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: string | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerNum = i + 1;
    const secLines: { text: string; num: number }[] = [];
    i++;
    while (i < last) {
      const l2 = lines[i]!;
      if (l2.startsWith('*** Add File: ') || l2.startsWith('*** Delete File: ') || l2.startsWith('*** Update File: ')) break;
      secLines.push({ text: l2, num: i + 1 });
      i++;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    edits.push(v4aEdit(kind, path, headerNum, secLines, strict));
  }
  return edits;
}

/* ---- Section 9: JSON edits ---- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Sections 1, 2 and 10: invocation, output, order and atomicity ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!moved.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
