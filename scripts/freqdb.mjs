#!/usr/bin/env node
// Frequency DB: validate freqdb/*.json and compile them into the file the site reads.
// No dependencies: Node >= 18.
//
// Usage:
//   node scripts/freqdb.mjs          validate only, print warnings
//   (build.mjs imports compileFreqDB and writes dist/data/freqdb.json)
//
// Sources:
//   freqdb/sources.json      { key: { title, url? } }, cited as "key" or "key:detail"
//   freqdb/allocations.json  layer 1, service allocations (RR Art. 5 Region 1, CNAF).
//                            Must not overlap each other. Services in CAPITALS are
//                            primary, in Mixed case secondary, as in the RR table.
//   freqdb/uses.json         layer 2, concrete signals and uses. May overlap anything.
//
// Frequencies are strings with an explicit unit: "433.92 MHz", "7000-7200 kHz".
// They are converted exactly (decimal string arithmetic) to integer Hz.

import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'freqdb');

const TAGS = new Set([
  'amateur', 'broadcast', 'aviation', 'maritime', 'satellite', 'weather', 'gnss', 'navigation',
  'ism', 'srd', 'iot', 'wifi', 'cellular', 'pmr', 'voice', 'data', 'digital', 'time', 'distress',
  'beacon', 'radar', 'radio-astronomy', 'passive',
]);
const LICENCE = new Set(['exempt', 'amateur', 'licensed', 'receive-only']);
const DEMOD = new Set(['NFM', 'WFM', 'AM', 'USB', 'LSB', 'CW', 'RAW']);
const ALLOC_KEYS = new Set(['id', 'range', 'name', 'services', 'rr', 'un', 'es', 'notes', 'tags', 'src', 'verified']);
const USE_KEYS = new Set(['id', 'name', 'f', 'range', 'bands', 'channels', 'tags', 'mode', 'bw', 'raster', 'pol',
  'demod', 'licence', 'es', 'notes', 'decoder', 'howto', 'sat', 'src', 'verified']);
// A use carrying one of these tags must sit inside an allocation to that service.
// Catches unit slips such as "7074 MHz" for an FT8 dial frequency.
const TAG_SERVICE = { amateur: /^amateur/i, broadcast: /^broadcasting/i };
const ITU_BANDS = [[3e3, 'vlf'], [3e4, 'lf'], [3e5, 'mf'], [3e6, 'hf'], [3e7, 'vhf'], [3e8, 'uhf'], [3e9, 'shf'], [3e10, 'ehf'], [3e11, null]];
const UNIT_EXP = { Hz: 0, kHz: 3, MHz: 6, GHz: 9 };

// "433.92", 6 -> 433920000, exactly. Throws on sub-Hz precision.
function decimalToHz(num, exp) {
  const [int, frac = ''] = num.split('.');
  const digits = (int + frac.padEnd(exp, '0'));
  const cut = int.length + exp;
  if (/[1-9]/.test(digits.slice(cut))) throw new Error(`${num} has sub-Hz precision`);
  const hz = Number(digits.slice(0, cut) || '0');
  if (!Number.isSafeInteger(hz)) throw new Error(`${num} out of range`);
  return hz;
}

// "7000-7200 kHz" -> [7000000, 7200000], "145.8 MHz" -> [145800000, 145800000]
export function parseFreq(s, { range = true } = {}) {
  if (typeof s !== 'string') throw new Error(`frequency must be a string with a unit, got ${JSON.stringify(s)}`);
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?)\s*)?(Hz|kHz|MHz|GHz)\s*$/.exec(s);
  if (!m) throw new Error(`"${s}": expected "<number> <Hz|kHz|MHz|GHz>"${range ? ' or "<lo>-<hi> <unit>"' : ''}`);
  if (m[2] && !range) throw new Error(`"${s}": a single frequency is expected here, not a range`);
  const e = UNIT_EXP[m[3]];
  const lo = decimalToHz(m[1], e), hi = m[2] ? decimalToHz(m[2], e) : lo;
  if (lo <= 0) throw new Error(`"${s}": frequency must be positive`);
  if (m[2] && !(lo < hi)) throw new Error(`"${s}": lower edge must be below upper edge`);
  return [lo, hi];
}

const ituBand = f => { for (let i = 0; i < ITU_BANDS.length - 1; i++) if (f >= ITU_BANDS[i][0] && f < ITU_BANDS[i + 1][0]) return ITU_BANDS[i][1]; return null; };
const bandTags = segs => [...new Set(segs.flatMap(([lo, hi]) => [ituBand(lo), ituBand(hi)]).filter(Boolean))];
const fmt = hz => hz >= 1e9 ? `${hz / 1e9} GHz` : hz >= 1e6 ? `${hz / 1e6} MHz` : hz >= 1e3 ? `${hz / 1e3} kHz` : `${hz} Hz`;

// Colour category for the band plan, from tags (uses) or the first primary service (allocations).
const CATS = [
  ['amateur', t => t.includes('amateur')],
  ['science', t => t.includes('radio-astronomy') || t.includes('time')],
  ['aviation', t => t.includes('aviation')],
  ['maritime', t => t.includes('maritime')],
  ['broadcast', t => t.includes('broadcast')],
  ['space', t => t.includes('satellite') || t.includes('gnss')],
  ['srd', t => ['ism', 'srd', 'iot', 'wifi'].some(x => t.includes(x))],
  ['mobile', () => true],
];
const category = tags => CATS.find(([, f]) => f(tags))[0];

async function load(name) {
  const file = join(DIR, name);
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { throw new Error(`freqdb/${name}: ${e.message}`); }
}

export async function compileFreqDB({ posts = [], tleGroups = [] } = {}) {
  const [sources, allocs, uses] = await Promise.all([load('sources.json'), load('allocations.json'), load('uses.json')]);
  const errors = [], warnings = [];
  const ids = new Set();
  const published = new Set(posts.map(p => p.slug));
  const groups = new Set(tleGroups.map(g => g.id));

  const check = (where, fn) => { try { return fn(); } catch (e) { errors.push(`${where}: ${e.message}`); return undefined; } };
  const str = (where, v, key, req = false) => {
    if (v === undefined) { if (req) errors.push(`${where}: missing "${key}"`); return undefined; }
    if (typeof v !== 'string' || !v.trim()) { errors.push(`${where}: "${key}" must be a non-empty string`); return undefined; }
    return v.trim();
  };
  const list = (where, v, key) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) { errors.push(`${where}: "${key}" must be an array`); return []; }
    return v;
  };

  function common(where, e, keys) {
    for (const k of Object.keys(e)) if (!keys.has(k)) errors.push(`${where}: unknown field "${k}"`);
    if (typeof e.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id)) errors.push(`${where}: "id" must be kebab-case`);
    else if (ids.has(e.id)) errors.push(`${where}: duplicate id`);
    else ids.add(e.id);
    const tags = list(where, e.tags, 'tags');
    for (const t of tags) if (!TAGS.has(t)) errors.push(`${where}: unknown tag "${t}" (allowed: ${[...TAGS].join(', ')})`);
    const src = list(where, e.src, 'src').map(s => {
      const [key, ...rest] = String(s).split(':');
      if (!sources[key]) { errors.push(`${where}: unknown source "${key}"`); return null; }
      return { title: sources[key].title, url: sources[key].url || null, detail: rest.join(':') || null };
    }).filter(Boolean);
    if (!src.length) errors.push(`${where}: at least one source ("src") is required`);
    if (e.verified !== undefined && typeof e.verified !== 'boolean') errors.push(`${where}: "verified" must be true or false`);
    return {
      id: e.id, tags, src,
      es: str(where, e.es, 'es') || null,
      notes: str(where, e.notes, 'notes') || null,
      verified: e.verified === true,
    };
  }

  // ---------- layer 1: allocations ----------
  const outAllocs = allocs.map((e, i) => {
    const where = `allocations.json[${i}]${e.id ? ` (${e.id})` : ''}`;
    const base = common(where, e, ALLOC_KEYS);
    const seg = check(where, () => parseFreq(e.range));
    // RR convention: primary services in CAPITALS ("MOBILE except aeronautical mobile"), secondary in Mixed case.
    const services = list(where, e.services, 'services').map(s => ({ name: s, primary: /^[A-Z][A-Z-]+\b/.test(s) }));
    if (!services.length) errors.push(`${where}: at least one service is required`);
    const rr = list(where, e.rr, 'rr');
    for (const n of rr) if (!/^5\.\d+[A-Z]*$/.test(n)) errors.push(`${where}: RR footnote "${n}" should look like "5.340"`);
    const un = list(where, e.un, 'un');
    for (const n of un) if (!/^UN-\d+$/.test(n)) errors.push(`${where}: CNAF note "${n}" should look like "UN-12"`);
    const segs = seg ? [seg] : [];
    return {
      ...base, layer: 'alloc',
      name: str(where, e.name, 'name') || services.map(s => s.name).join(', '),
      segs, ch: [], services, rr, un,
      cat: category([...base.tags, ...services.filter(s => s.primary).slice(0, 1).map(s => s.name.toLowerCase())]),
      bands: bandTags(segs),
    };
  });

  // Allocations form a partition of the covered spectrum: no overlaps.
  const sorted = outAllocs.filter(a => a.segs.length).sort((a, b) => a.segs[0][0] - b.segs[0][0]);
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1], c = sorted[i];
    if (c.segs[0][0] < p.segs[0][1]) errors.push(`allocations overlap: ${p.id} (${fmt(p.segs[0][0])}-${fmt(p.segs[0][1])}) and ${c.id} (${fmt(c.segs[0][0])}-${fmt(c.segs[0][1])})`);
  }

  // ---------- layer 2: uses and signals ----------
  const outUses = uses.map((e, i) => {
    const where = `uses.json[${i}]${e.id ? ` (${e.id})` : ''}`;
    const base = common(where, e, USE_KEYS);
    const name = str(where, e.name, 'name', true);
    const given = ['f', 'range', 'bands'].filter(k => e[k] !== undefined);
    if (given.length > 1) errors.push(`${where}: use only one of "f", "range", "bands"`);
    if (!given.length && !e.channels) errors.push(`${where}: needs "f", "range", "bands" or "channels"`);
    let segs = [];
    if (e.f !== undefined) segs = [check(where, () => parseFreq(e.f, { range: false }))];
    if (e.range !== undefined) segs = [check(where, () => parseFreq(e.range))];
    if (e.bands !== undefined) segs = list(where, e.bands, 'bands').map(b => check(where, () => parseFreq(b)));
    segs = segs.filter(Boolean).sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < segs.length; k++) if (segs[k][0] < segs[k - 1][1]) errors.push(`${where}: bands overlap each other`);

    const ch = list(where, e.channels, 'channels').map((c, k) => {
      if (!c || typeof c !== 'object') { errors.push(`${where}: channel ${k} must be { f, label }`); return null; }
      const f = check(`${where} channel ${k}`, () => parseFreq(c.f, { range: false }));
      if (!f) return null;
      const ranged = segs.filter(([lo, hi]) => lo < hi);
      if (ranged.length && !ranged.some(([lo, hi]) => f[0] >= lo && f[0] <= hi)) errors.push(`${where}: channel ${c.f} lies outside the entry's own range`);
      return { f: f[0], label: typeof c.label === 'string' ? c.label : '' };
    }).filter(Boolean);

    const hzField = key => e[key] === undefined ? null : check(where, () => parseFreq(e[key], { range: false })[0]);
    const bw = hzField('bw'), raster = hzField('raster');
    const allPoints = [...segs.flat(), ...ch.map(c => c.f)];
    const span = allPoints.length ? Math.min(...allPoints) : 0;
    if (bw && span && bw > span) errors.push(`${where}: bandwidth ${fmt(bw)} is larger than the frequency itself, check the units`);

    if (e.licence !== undefined && !LICENCE.has(e.licence)) errors.push(`${where}: "licence" must be one of ${[...LICENCE].join(', ')}`);
    if (e.demod !== undefined && !DEMOD.has(e.demod)) errors.push(`${where}: "demod" must be one of ${[...DEMOD].join(', ')}`);
    let decoder = null;
    if (e.decoder !== undefined) {
      if (!e.decoder?.name || !/^https?:\/\//.test(e.decoder?.url || '')) errors.push(`${where}: "decoder" must be { name, url }`);
      else decoder = { name: e.decoder.name, url: e.decoder.url };
    }
    let howto = null;
    if (e.howto !== undefined) {
      const m = /^post:([a-z0-9-]+)$/.exec(e.howto);
      if (m) {
        if (published.has(m[1])) howto = { label: posts.find(p => p.slug === m[1]).title, href: `#post-${m[1]}` };
        else warnings.push(`${where}: how-to post "${m[1]}" is not published in this build, link left out`);
      } else if (/^https?:\/\//.test(e.howto)) howto = { label: e.howto.replace(/^https?:\/\//, ''), href: e.howto };
      else errors.push(`${where}: "howto" must be "post:<slug>" or an http(s) URL`);
    }
    let sat = null;
    if (e.sat !== undefined) {
      if (!Number.isInteger(e.sat?.norad)) errors.push(`${where}: "sat.norad" must be a catalog number`);
      else if (e.sat.group && groups.size && !groups.has(e.sat.group)) errors.push(`${where}: "sat.group" ${e.sat.group} is not a tleGroups id in site.config.json`);
      else sat = { norad: e.sat.norad, group: e.sat.group || null };
    }
    return {
      ...base, layer: 'use', name, segs, ch,
      mode: str(where, e.mode, 'mode') || null,
      bw, raster,
      pol: str(where, e.pol, 'pol') || null,
      demod: e.demod || null,
      licence: e.licence || null,
      decoder, howto, sat,
      cat: category(base.tags),
      bands: bandTags([...segs, ...ch.map(c => [c.f, c.f])]),
    };
  });

  // Cross-check uses against allocations (units sanity).
  const allocOf = f => outAllocs.filter(a => a.segs.some(([lo, hi]) => f >= lo && f <= hi));
  for (const u of outUses) {
    for (const [tag, re] of Object.entries(TAG_SERVICE)) {
      if (!u.tags.includes(tag)) continue;
      const points = [...u.segs.map(([lo, hi]) => (lo + hi) / 2), ...u.ch.map(c => c.f)];
      for (const f of points) {
        if (!allocOf(f).some(a => a.services.some(s => re.test(s.name)))) {
          (tag === 'amateur' ? errors : warnings).push(`uses.json (${u.id}): tagged "${tag}" but ${fmt(f)} is not inside any allocation to the ${tag} service, check the units`);
        }
      }
    }
  }

  if (errors.length) throw new Error(`freqdb: ${errors.length} error(s)\n  ${errors.join('\n  ')}`);
  const entries = [...outAllocs, ...outUses];
  const unverified = entries.filter(e => !e.verified).length;
  if (unverified) warnings.push(`${unverified} of ${entries.length} entries not yet verified against their sources`);
  return { data: { generated: new Date().toISOString(), entries }, warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(await readFile(join(ROOT, 'site.config.json'), 'utf8'));
  try {
    const { data, warnings } = await compileFreqDB({ tleGroups: config.tleGroups });
    for (const w of warnings) console.log(`WARN ${w}`);
    console.log(`freqdb: ${data.entries.length} entries OK`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
