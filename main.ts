// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** A file's lines per SPEC section 3. */
interface FileParts { br: string; lines: string[]; final: boolean }
function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}
function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Occurrences of O in file lines at the first tier (0,1,2; strict: 0 only) with any. */
function occurrences(file: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const on = o.map((x) => normLine(x, t));
    const pos: number[] = [];
    for (let i = 0; i + o.length <= file.length; i++) {
      let ok = true;
      for (let k = 0; k < o.length; k++) if (normLine(file[i + k]!, t) !== on[k]) { ok = false; break; }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface NEnt { text: string; ctx: number | null }
/** Build the replacement segment: context lines are the file's own matched lines; at tier 2
 *  other lines are re-indented from O's first line's leading whitespace to the file's. */
function buildN(file: string[], o: string[], n: NEnt[], tier: number, pos: number): string[] {
  const lead = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
  const F = lead(file[pos] ?? '');
  const P = lead(o[0] ?? '');
  return n.map((e) => {
    if (e.ctx !== null) return file[pos + e.ctx]!;
    if (tier === 2 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(P)) return F + e.text.slice(P.length);
    return e.text;
  });
}

/** Split a hunk/chunk body into its O lines and N entries (context entries carry their O index). */
function splitBody(body: { kind: string; text: string }[]): { o: string[]; n: NEnt[] } {
  const o: string[] = [];
  const n: NEnt[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === ' ') { o.push(b.text); n.push({ text: b.text, ctx: oi }); oi += 1; }
    else if (b.kind === '-') { o.push(b.text); oi += 1; }
    else if (b.kind === '+') { n.push({ text: b.text, ctx: null }); }
  }
  return { o, n };
}

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

/** SPEC section 6: unified diffs. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Body { kind: string; text: string; noeol: boolean }
  interface Hunk { a: number; body: Body[] }
  interface Sec {
    diffOld: string | null; diffNew: string | null;
    hdrOld: string | null | undefined; hdrNew: string | null | undefined;
    renOld: string | null; renNew: string | null;
    create: boolean; del: boolean; hunks: Hunk[];
  }
  const pathFromHeader = (s: string): string => s.split('\t')[0]!.trim();
  const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const diffPaths = (l: string): [string, string] | null => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
    return m ? [m[1]!, m[2]!] : null;
  };
  const secs: Sec[] = [];
  let i = 0;
  const parseHeader = (sec: Sec): void => {
    let pairSeen = false;
    let seenHunk = false;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('@@')) {
        const hm = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
        if (!hm) throw new Exit2(`error: parse ${i + 1}`);
        const hunk: Hunk = { a: parseInt(hm[1]!, 10), body: [] };
        i += 1;
        while (i < lines.length) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
            hunk.body.push({ kind: b === '' ? ' ' : b[0]!, text: b === '' ? '' : b.slice(1), noeol: false });
            i += 1;
            continue;
          }
          if (b.startsWith('\\')) {
            const last = hunk.body[hunk.body.length - 1];
            if (last) last.noeol = true;
            i += 1;
            continue;
          }
          break;
        }
        while (hunk.body.length > 0) {
          const last = hunk.body[hunk.body.length - 1]!;
          if (last.kind === ' ' && last.text === '') hunk.body.pop();
          else break;
        }
        sec.hunks.push(hunk);
        seenHunk = true;
        continue;
      }
      if (l.startsWith('diff --git ')) return;
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (pairSeen || seenHunk) return;
          const o = pathFromHeader(l.slice(4));
          const n = pathFromHeader(lines[i + 1]!.slice(4));
          sec.hdrOld = o === '/dev/null' ? null : stripAB(o);
          sec.hdrNew = n === '/dev/null' ? null : stripAB(n);
          pairSeen = true;
          i += 2;
          continue;
        }
        if (!seenHunk) throw new Exit2(`error: parse ${i + 2}`);
        i += 1;
        continue;
      }
      if (!seenHunk) {
        if (l.startsWith('rename from ')) sec.renOld = l.slice(12).trim();
        else if (l.startsWith('rename to ')) sec.renNew = l.slice(10).trim();
        else if (l.startsWith('new file mode')) sec.create = true;
        else if (l.startsWith('deleted file mode')) sec.del = true;
      }
      i += 1;
    }
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const dp = diffPaths(l);
      if (!dp) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Sec = { diffOld: dp[0], diffNew: dp[1], hdrOld: undefined, hdrNew: undefined, renOld: null, renNew: null, create: false, del: false, hunks: [] };
      secs.push(sec);
      i += 1;
      parseHeader(sec);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Sec = { diffOld: null, diffNew: null, hdrOld: undefined, hdrNew: undefined, renOld: null, renNew: null, create: false, del: false, hunks: [] };
      secs.push(sec);
      parseHeader(sec);
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return secs.map((sec) => {
    const oldP = sec.hdrOld !== undefined ? sec.hdrOld : (sec.renOld ?? sec.diffOld);
    const newP = sec.hdrNew !== undefined ? sec.hdrNew : (sec.renNew ?? sec.diffNew);
    const create = sec.create || sec.hdrOld === null;
    const del = sec.del || sec.hdrNew === null;
    const move = !create && !del && oldP !== null && newP !== null && oldP !== newP;
    return (tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (create) {
        const np = newP!;
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let noeol = false;
        for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') { plus.push(b.text); noeol = b.noeol; }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noeol ? '' : '\n'));
        return;
      }
      if (del) {
        const op = oldP!;
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const op = oldP!;
      const src = tree.get(op);
      if (src === null) throw new Fail('missing', op);
      const parts = splitFile(src);
      let d = 0;
      for (const h of sec.hunks) {
        const { o, n } = splitBody(h.body);
        let lastNoeol = false;
        let hasCtxPlus = false;
        for (let k = h.body.length - 1; k >= 0; k--) {
          const b = h.body[k]!;
          if (b.kind === ' ' || b.kind === '+') { lastNoeol = b.noeol; hasCtxPlus = true; break; }
        }
        if (o.length > 0) {
          const occ = occurrences(parts.lines, o, strict);
          if (!occ) throw new Fail('no-match', op);
          const target = h.a - 1 + d;
          let best = occ.pos[0]!;
          let bestDist = Math.abs(best - target);
          for (const p of occ.pos) {
            const dist = Math.abs(p - target);
            if (dist < bestDist) { best = p; bestDist = dist; }
          }
          const toEnd = best + o.length === parts.lines.length;
          const seg = buildN(parts.lines, o, n, occ.tier, best);
          parts.lines.splice(best, o.length, ...seg);
          if (toEnd) parts.final = hasCtxPlus ? !lastNoeol : parts.lines.length > 0;
          d += n.length - o.length;
        } else {
          let ins = h.a + d;
          if (ins < 0) ins = 0;
          if (ins > parts.lines.length) ins = parts.lines.length;
          const atEnd = ins === parts.lines.length;
          const seg = n.map((e) => e.text);
          parts.lines.splice(ins, 0, ...seg);
          if (atEnd && seg.length > 0) parts.final = !lastNoeol;
          d += n.length;
        }
      }
      const text = joinFile(parts);
      if (move) {
        tree.now.set(newP!, text);
        tree.now.set(op, null);
        tree.moves.push([op, newP!]);
      } else {
        tree.now.set(op, text);
      }
    };
  });
}

/** SPEC section 7: SEARCH/REPLACE blocks. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block { path: string; old: string[]; nw: string[] }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    let rep = -1;
    if (eq >= 0) for (let j = eq + 1; j < lines.length; j++) if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, old: lines.slice(searchIdx + 1, eq), nw: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const parts = splitFile(cur);
    const occ = occurrences(parts.lines, b.old, strict);
    if (!occ) throw new Fail('no-match', b.path);
    if (occ.pos.length > 1) throw new Fail('ambiguous', b.path);
    const pos = occ.pos[0]!;
    const seg = buildN(parts.lines, b.old, b.nw.map((t) => ({ text: t, ctx: null })), occ.tier, pos);
    parts.lines.splice(pos, b.old.length, ...seg);
    tree.now.set(b.path, joinFile(parts));
  });
}

/** SPEC section 8: V4A patches. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  interface Body { kind: string; text: string }
  interface Chunk { anchor: string | null; eof: boolean; body: Body[] }
  interface VSec { kind: 'add' | 'delete' | 'update'; path: string; moveTo: string | null; addLines: string[]; chunks: Chunk[]; lineNo: number }
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = /^\*\*\* (Add File|Delete File|Update File): /;
  const secs: VSec[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    const m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(l);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const kind = (m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update') as VSec['kind'];
    const sec: VSec = { kind, path: m[2]!.trim(), moveTo: null, addLines: [], chunks: [], lineNo: i + 1 };
    i += 1;
    const raw: { text: string; idx: number }[] = [];
    while (i < last) {
      const t = lines[i]!;
      if (secStart.test(t)) break;
      raw.push({ text: t, idx: i });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text === '') sec.addLines.push('');
        else if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
    } else {
      let j = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        j = 1;
      }
      let cur: Chunk | null = null;
      for (; j < raw.length; j++) {
        const r = raw[j]!;
        if (r.text.startsWith('@@')) {
          cur = { anchor: r.text.slice(2).trim() === '' ? null : r.text.slice(2).trim(), eof: false, body: [] };
          sec.chunks.push(cur);
          continue;
        }
        if (r.text === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${r.idx + 1}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (cur === null) {
          if (sec.chunks.length === 0) { cur = { anchor: null, eof: false, body: [] }; sec.chunks.push(cur); }
          else throw new Exit2(`error: parse ${r.idx + 1}`);
        }
        if (r.text === '' || r.text.startsWith(' ') || r.text.startsWith('-') || r.text.startsWith('+')) {
          cur.body.push({ kind: r.text === '' ? ' ' : r.text[0]!, text: r.text === '' ? '' : r.text.slice(1) });
        } else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
    secs.push(sec);
  }
  return secs.map((sec) => (tree: Tree): void => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const parts = splitFile(cur);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < parts.lines.length; k++) {
            if (normLine(parts.lines[k]!, t) === normLine(ch.anchor, t)) { found = k; break; }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      const { o, n } = splitBody(ch.body);
      if (o.length === 0) {
        const ins = ch.eof ? parts.lines.length : cursor;
        const seg = n.map((e) => e.text);
        parts.lines.splice(ins, 0, ...seg);
        cursor = ins + seg.length;
      } else {
        let occ: { tier: number; pos: number[] } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const on = o.map((x) => normLine(x, t));
          const pos: number[] = [];
          for (let k = cursor; k + o.length <= parts.lines.length; k++) {
            let ok = true;
            for (let q = 0; q < o.length; q++) if (normLine(parts.lines[k + q]!, t) !== on[q]) { ok = false; break; }
            if (ok) pos.push(k);
          }
          if (ch.eof) {
            const eofPos = pos.filter((p) => p + o.length === parts.lines.length);
            if (eofPos.length > 0) { occ = { tier: t, pos: eofPos }; break; }
          } else if (pos.length > 0) { occ = { tier: t, pos }; break; }
        }
        if (!occ) throw new Fail('no-match', sec.path);
        const pos = occ.pos[0]!;
        const seg = buildN(parts.lines, o, n, occ.tier, pos);
        parts.lines.splice(pos, o.length, ...seg);
        cursor = pos + seg.length;
      }
    }
    const text = joinFile(parts);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, text);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, text);
    }
  });
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of beforeMoves) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row { key: string; text: string; kind: string; path: string }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, kind: was === null ? 'A' : now === null ? 'D' : 'M', path: p });
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) === null || tree.original(newP) !== null) continue;
    const di = rows.findIndex((r) => r.kind === 'D' && r.path === oldP);
    const ai = rows.findIndex((r) => r.kind === 'A' && r.path === newP);
    if (di < 0 || ai < 0) continue;
    rows.splice(Math.max(di, ai), 1);
    rows.splice(Math.min(di, ai), 1);
    rows.push({ key: newP, text: `R ${oldP} -> ${newP}`, kind: 'R', path: newP });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
