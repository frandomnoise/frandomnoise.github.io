#!/usr/bin/env node
// frandomnoise build script. No dependencies: Node >= 18 only.
//
// Usage:
//   node scripts/build.mjs            build dist/ (published posts only)
//   node scripts/build.mjs --drafts   include status: draft posts
//   node scripts/build.mjs --serve    build, then serve dist/ on http://localhost:8080
//
// Output (dist/):
//   index.html     copied from site/index.html
//   posts.json     published posts, newest first, with pre-rendered HTML
//   CNAME          custom domain for GitHub Pages
//   robots.txt
//   sitemap.xml
//   data/          copied from ./data if it exists (TLE, propagation JSON...)
//   data/freqdb.json  compiled and validated from freqdb/*.json (see scripts/freqdb.mjs)

import { readFile, writeFile, readdir, mkdir, rm, cp, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { texToMathML } from './tex2mathml.mjs';
import { compileFreqDB } from './freqdb.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const config = JSON.parse(await readFile(join(ROOT, 'site.config.json'), 'utf8'));
const OUT = join(ROOT, config.outDir);
const BASE_URL = `https://${config.domain}/`;

// ---------- front matter ----------

function parseFrontMatter(src, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${file}: bad front matter line: ${line}`);
    let [, key, value] = kv;
    value = value.trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean);
    } else {
      value = unquote(value);
    }
    meta[key] = value;
  }
  return { meta, body: m[2] };
}

function unquote(s) {
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

// ---------- minimal Markdown renderer ----------
// Supports: ATX headings, paragraphs, fenced code (```lang), blockquotes,
// ordered/unordered lists (single level), tables (GFM pipes), hr, images,
// links, **bold**, *italic*, `code`, $inline$ and $$display$$ LaTeX math (converted to MathML
// by tex2mathml.mjs) and raw HTML blocks. The word TODO is highlighted so placeholders stay visible.

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function slugify(s) {
  return s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
}

function inline(s) {
  const codes = [], maths = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(esc(c)) - 1}\u0000`);
  // $...$ inline math: no space just inside the dollars, no digit right after the closing one.
  s = s.replace(/\$([^\s$](?:[^$]*[^\s$])?)\$(?!\d)/g, (_, tex) => `\u0001${maths.push(texToMathML(tex)) - 1}\u0001`);
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_, alt, src, t) => `<img src="${src}" alt="${alt}"${t ? ` title="${t}"` : ''} loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const ext = /^https?:/.test(href);
    return `<a href="${href}"${ext ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\bTODO\b/g, '<mark class="todo">TODO</mark>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => maths[i]);
  return s;
}

function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = l =>
    /^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+\.\s|\$\$|<\w|---\s*$|\|)/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    let m;
    if ((m = /^```\s*([\w+-]*)\s*$/.exec(line))) {
      const lang = m[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang ? ` class="lang-${lang}" data-lang="${lang}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\$\$/.test(line)) {
      const buf = [line.replace(/^\$\$/, '')];
      if (!/\$\$\s*$/.test(line.slice(2))) {
        i++;
        while (i < lines.length && !/\$\$\s*$/.test(lines[i])) buf.push(lines[i++]);
        buf.push(lines[i] ?? '');
      }
      i++;
      out.push(`<div class="math">${texToMathML(buf.join('\n').replace(/\$\$\s*$/, '').trim(), true)}</div>`);
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const level = m[1].length;
      const html = inline(m[2]);
      out.push(`<h${level} id="${slugify(m[2])}">${html}</h${level}>`);
      i++; continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          item += ' ' + lines[i++].trim();
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-+/.test(lines[i + 1])) {
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(line);
      const align = cells(lines[i + 1]).map(c => c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left');
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag} style="text-align:${align[k] || 'left'}">${inline(c)}</${tag}>`;
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, k) => td('td', c, k)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^<\w/.test(line)) {
      const buf = [];
      while (i < lines.length && lines[i].trim()) buf.push(lines[i++]);
      // Raw HTML passes through untouched, except that TODO placeholders are highlighted
      // in text content (not inside tags or attributes).
      out.push(buf.join('\n').replace(/>([^<]*)</g, (_, t) => `>${t.replace(/\bTODO\b/g, '<mark class="todo">TODO</mark>')}<`));
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i]))) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ---------- build ----------

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function loadPosts(includeDrafts) {
  const dir = join(ROOT, config.postsDir);
  const files = (await readdir(dir)).filter(f => extname(f) === '.md');
  const posts = [];
  for (const f of files) {
    const slug = f.slice(0, -3);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`${f}: slug must be lowercase kebab-case`);
    const { meta, body } = parseFrontMatter(await readFile(join(dir, f), 'utf8'), f);
    for (const k of ['title', 'date', 'status']) if (!meta[k]) throw new Error(`${f}: missing "${k}"`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) throw new Error(`${f}: date must be YYYY-MM-DD`);
    if (!['published', 'draft'].includes(meta.status)) throw new Error(`${f}: status must be published|draft`);
    if (meta.status === 'draft' && !includeDrafts) continue;
    const words = body.split(/\s+/).filter(Boolean).length;
    posts.push({
      slug,
      title: meta.title,
      date: meta.date,
      tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [],
      summary: meta.summary || '',
      status: meta.status,
      readingMinutes: Math.max(1, Math.round(words / 220)),
      html: (() => { try { return renderMarkdown(body); } catch (e) { throw new Error(`${f}: ${e.message}`); } })(),
    });
  }
  posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  return posts;
}

function sitemap(posts) {
  // Hash routes (#post-...) are not indexed as separate URLs by crawlers,
  // so the sitemap only lists the root, with lastmod = newest post.
  const lastmod = posts[0]?.date || new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE_URL}</loc><lastmod>${lastmod}</lastmod></url>
</urlset>
`;
}

async function build() {
  const includeDrafts = args.has('--drafts');
  const posts = await loadPosts(includeDrafts);
  // Validate before touching dist/, so a data error never leaves a half-built site.
  const freqdb = await compileFreqDB({ posts, tleGroups: config.tleGroups });

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  await cp(join(ROOT, config.siteDir), OUT, { recursive: true });
  await writeFile(join(OUT, 'posts.json'), JSON.stringify(posts));
  // GitHub's default *.github.io host needs no CNAME; a custom domain does.
  if (!config.domain.endsWith('.github.io')) await writeFile(join(OUT, 'CNAME'), config.domain + '\n');
  await writeFile(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${BASE_URL}sitemap.xml\n`);
  await writeFile(join(OUT, 'sitemap.xml'), sitemap(posts));
  await writeFile(join(OUT, '.nojekyll'), '');

  const dataDir = join(ROOT, config.staticDataDir);
  if (await exists(dataDir)) await cp(dataDir, join(OUT, 'data'), { recursive: true });
  await mkdir(join(OUT, 'data'), { recursive: true });
  await writeFile(join(OUT, 'data', 'freqdb.json'), JSON.stringify(freqdb.data));
  for (const w of freqdb.warnings) console.log(`WARN ${w}`);

  console.log(`built ${posts.length} post(s), ${freqdb.data.entries.length} freqdb entries${includeDrafts ? ' (drafts included)' : ''} -> ${config.outDir}/`);
}

function serve(port = 8080) {
  const types = { '.html': 'text/html', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = resolve(OUT, '.' + (path.endsWith('/') ? path + 'index.html' : path));
    if (!file.startsWith(OUT)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': (types[extname(file)] || 'application/octet-stream') + '; charset=utf-8' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }).listen(port, () => console.log(`serving ${config.outDir}/ on http://localhost:${port}`));
}

await build();
if (args.has('--serve')) serve();
