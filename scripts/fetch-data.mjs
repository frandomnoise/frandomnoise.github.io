#!/usr/bin/env node
// Download the static data the site reads at runtime. No dependencies: Node >= 18.
// Run by the deploy workflow before the build (on push and on a schedule), so the
// visitor's browser never calls third-party APIs.
//
// Usage: node scripts/fetch-data.mjs
//
// Writes:
//   data/gp/<group>.json   CelesTrak GP element sets as CCSDS OMM (JSON); groups in site.config.json.
//                          OMM rather than TLE because catalog numbers > 99999 have no TLE form.
//   data/gp/groups.json    [{ id, label, count, newestEpoch, stale }] read by #satellites
//   data/propagation.json  space weather (NOAA SWPC) + European ionosondes (GIRO via KC2G)
//
// Each source fails independently. When a source fails, the file published by the
// previous deploy (https://<domain>/data/...) is reused and marked stale, so a CelesTrak
// or NOAA outage never empties the live site. Exit code is 1 only if nothing at all
// could be written.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(join(ROOT, 'site.config.json'), 'utf8'));
const DATA = join(ROOT, config.staticDataDir);
const UA = `frandomnoise-site-build (+https://${config.domain}/)`;
const LIVE = `https://${config.domain}/${config.staticDataDir}/`;

// [{ id, label, celestrak?: '<CelesTrak GROUP>', norad?: [catalog numbers] }]
const TLE_GROUPS = config.tleGroups;

// European ionosondes: lat/lon box and maximum data age.
const IONO_BOX = { latMin: 30, latMax: 72, lonMin: -20, lonMax: 45 };
const IONO_MAX_AGE_H = 6;

async function get(url, type = 'text') {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30e3) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return type === 'json' ? r.json() : r.text();
}

// CelesTrak answers some errors ("No GP data found", "Invalid query") with plain text
// instead of JSON, sometimes with HTTP 200: parse defensively and keep only valid records.
async function getOMM(query) {
  const text = await get(`https://celestrak.org/NORAD/elements/gp.php?${query}&FORMAT=json`);
  let list;
  try { list = JSON.parse(text); } catch (e) { throw new Error(text.slice(0, 120).trim() || 'empty response'); }
  if (!Array.isArray(list)) throw new Error('unexpected response');
  return list.filter(o => o && o.EPOCH && Number.isFinite(o.MEAN_MOTION) && Number.isFinite(o.NORAD_CAT_ID));
}

const newestEpoch = list => list.reduce((m, o) => (!m || o.EPOCH > m ? o.EPOCH : m), null);

// A group is a CelesTrak group, a list of catalog numbers, or both (merged, deduplicated).
async function fetchGroupFromCelestrak(g) {
  const byId = new Map(), missing = [];
  if (g.celestrak) {
    const list = await getOMM(`GROUP=${encodeURIComponent(g.celestrak)}`);
    if (!list.length) throw new Error(`group ${g.celestrak} is empty`);
    for (const o of list) byId.set(o.NORAD_CAT_ID, o);
  }
  // CelesTrak takes one CATNR per query. Unknown or decayed numbers come back as
  // HTTP 404 or "No GP data found": skip just that one.
  for (const n of g.norad || []) {
    if (byId.has(Number(n))) continue;
    const list = await getOMM(`CATNR=${Number(n)}`).catch(() => []);
    if (list.length) byId.set(list[0].NORAD_CAT_ID, list[0]); else missing.push(n);
  }
  if (!byId.size) throw new Error(`none of ${(g.norad || []).join(', ')} found`);
  return { list: [...byId.values()], missing };
}

async function fetchGP(g) {
  let list, stale = false, note = '';
  try {
    const r = await fetchGroupFromCelestrak(g);
    list = r.list;
    if (r.missing.length) note = ` (not in CelesTrak: ${r.missing.join(', ')})`;
  } catch (e) {
    // Fall back to what the live site is serving from the previous deploy.
    const prev = await get(`${LIVE}gp/${g.id}.json`, 'json').catch(() => null);
    if (!Array.isArray(prev) || !prev.length) throw new Error(`${g.id}: ${e.message}; no previous copy either`);
    list = prev; stale = true; note = ` (CelesTrak failed: ${e.message}; reusing previous deploy)`;
  }
  await writeFile(join(DATA, 'gp', `${g.id}.json`), JSON.stringify(list));
  return { id: g.id, label: g.label, count: list.length, newestEpoch: newestEpoch(list), stale, msg: `${g.id}: ${list.length} element sets${note}` };
}

const iso = s => (s.endsWith('Z') || /[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');

// Planetary Kp: observed values, the current estimate and NOAA's 3-day forecast, one list.
async function fetchKp() {
  const raw = await get('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json', 'json');
  // Format has been both an array of objects and an array of arrays with a header row.
  const rows = Array.isArray(raw[0])
    ? raw.slice(1).map(r => ({ time: r[0], kp: parseFloat(r[1]), kind: r[2] }))
    : raw.map(r => ({ time: r.time_tag, kp: parseFloat(r.kp ?? r.Kp), kind: r.observed }));
  const list = rows.filter(r => r.time && Number.isFinite(r.kp))
    .map(r => ({ time: new Date(iso(r.time.replace(' ', 'T'))).toISOString(), kp: r.kp, kind: r.kind || 'observed' }))
    .sort((a, b) => a.time.localeCompare(b.time));
  const obs = list.filter(r => r.kind === 'observed');
  if (!obs.length) throw new Error('Kp: no observed values');
  const from = Date.parse(obs[obs.length - 1].time) - 45 * 3600e3; // last 48 h of observations + forecast
  return { series: list.filter(r => Date.parse(r.time) >= from), latest: obs[obs.length - 1] };
}

// NOAA space weather scales: R (radio blackouts), S (radiation storms), G (geomagnetic storms).
async function fetchScales() {
  const raw = await get('https://services.swpc.noaa.gov/products/noaa-scales.json', 'json');
  const n = v => (v === null || v === undefined || v === '' ? null : Number(v));
  const cur = raw['0'];
  if (!cur) throw new Error('scales: no current entry');
  return {
    time: new Date(iso(`${cur.DateStamp}T${cur.TimeStamp}`)).toISOString(),
    now: { R: n(cur.R.Scale), S: n(cur.S.Scale), G: n(cur.G.Scale) },
    // Probabilities in %, G as the predicted scale level.
    days: ['1', '2', '3'].filter(k => raw[k]).map(k => ({
      date: raw[k].DateStamp,
      rMinor: n(raw[k].R.MinorProb), rMajor: n(raw[k].R.MajorProb), s: n(raw[k].S.Prob), g: n(raw[k].G.Scale),
    })),
  };
}

// GOES X-ray flux, 0.1-0.8 nm (the band that defines flare classes), 5-minute maxima over 24 h.
async function fetchXray() {
  const raw = await get('https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json', 'json');
  const rows = raw.filter(r => r.energy === '0.1-0.8nm' && Number.isFinite(r.flux) && r.flux > 0)
    .map(r => [Date.parse(iso(r.time_tag)), r.flux]).sort((a, b) => a[0] - b[0]);
  if (!rows.length) throw new Error('X-ray: empty');
  const bins = new Map();
  for (const [t, f] of rows) { const k = Math.floor(t / 300e3) * 300e3; bins.set(k, Math.max(bins.get(k) || 0, f)); }
  const peak = rows.reduce((m, r) => (r[1] > m[1] ? r : m));
  const last = rows[rows.length - 1];
  return {
    flux: last[1], time: new Date(last[0]).toISOString(),
    peak: peak[1], peakTime: new Date(peak[0]).toISOString(),
    series: [...bins].map(([t, f]) => [new Date(t).toISOString().slice(0, 16), +f.toPrecision(3)]),
  };
}

// Real-time solar wind at L1 (only the spacecraft NOAA marks active), 10-minute means over 24 h.
async function fetchWind() {
  const [mag, plasma] = await Promise.all([
    get('https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json', 'json'),
    get('https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json', 'json'),
  ]);
  const bins = new Map();
  const bin = t => { const k = Math.floor(Date.parse(iso(t)) / 600e3) * 600e3; if (!bins.has(k)) bins.set(k, { bz: [], bt: [], v: [], n: [] }); return bins.get(k); };
  for (const r of mag) if (r.active && Number.isFinite(r.bz_gsm) && Number.isFinite(r.bt)) { const b = bin(r.time_tag); b.bz.push(r.bz_gsm); b.bt.push(r.bt); }
  for (const r of plasma) if (r.active && Number.isFinite(r.proton_speed)) { const b = bin(r.time_tag); b.v.push(r.proton_speed); if (Number.isFinite(r.proton_density)) b.n.push(r.proton_density); }
  const mean = a => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);
  const series = [...bins].sort((a, b) => a[0] - b[0])
    .map(([t, b]) => [new Date(t).toISOString().slice(0, 16), mean(b.bz), mean(b.bt), mean(b.v), mean(b.n)])
    .filter(r => r[1] !== null || r[3] !== null);
  if (!series.length) throw new Error('solar wind: empty');
  const lastWith = i => [...series].reverse().find(r => r[i] !== null);
  const m = lastWith(1), p = lastWith(3);
  return {
    time: (m || p)[0] + ':00Z', bz: m ? m[1] : null, bt: m ? m[2] : null, speed: p ? p[3] : null, density: p ? p[4] : null,
    series,
  };
}

async function fetchF107() {
  const raw = await get('https://services.swpc.noaa.gov/json/f107_cm_flux.json', 'json');
  const list = raw.filter(r => Number.isFinite(r.flux)).sort((a, b) => b.time_tag.localeCompare(a.time_tag));
  if (!list.length) throw new Error('F10.7: empty');
  const mean = list.find(r => Number.isFinite(r.ninety_day_mean));
  return {
    sfi: list[0].flux,
    sfiTime: new Date(iso(list[0].time_tag)).toISOString(),
    sfi90: mean ? mean.ninety_day_mean : null,
  };
}

async function fetchIonosondes() {
  const raw = await get('https://prop.kc2g.com/api/stations.json', 'json');
  const now = Date.now();
  const out = [];
  for (const x of raw) {
    const s = x.station || {};
    const lat = parseFloat(s.latitude);
    let lon = parseFloat(s.longitude);
    if (lon > 180) lon -= 360;
    const t = Date.parse(iso(x.time || ''));
    if (![lat, lon, t, x.fof2].every(Number.isFinite)) continue;
    if (lat < IONO_BOX.latMin || lat > IONO_BOX.latMax || lon < IONO_BOX.lonMin || lon > IONO_BOX.lonMax) continue;
    if (now - t > IONO_MAX_AGE_H * 3600e3) continue;
    out.push({
      station: s.name, code: s.code, lat, lon,
      foF2: x.fof2,
      hmF2: Number.isFinite(x.hmf2) ? x.hmf2 : null,
      mufd: Number.isFinite(x.mufd) ? x.mufd : null, // MUF(3000)F2
      cs: Number.isFinite(x.cs) ? x.cs : null,       // ARTIST autoscaling confidence, -1 = unknown
      time: new Date(t).toISOString(),
    });
  }
  return out.sort((a, b) => b.lat - a.lat);
}

await mkdir(join(DATA, 'gp'), { recursive: true });

// The previous deploy's propagation.json: fallback if every source fails, and the
// place where the 36 h ionosonde history accumulates (there is no database).
const prevProp = await get(`${LIVE}propagation.json`, 'json').catch(() => null);

const SPACE = { kp: fetchKp, f107: fetchF107, iono: fetchIonosondes, scales: fetchScales, xray: fetchXray, wind: fetchWind };
const results = await Promise.allSettled([
  ...TLE_GROUPS.map(fetchGP),
  ...Object.values(SPACE).map(f => f()),
]);
const ok = r => r.status === 'fulfilled';
const sw = Object.fromEntries(Object.keys(SPACE).map((k, i) => [k, results[TLE_GROUPS.length + i]]));
const val = k => (ok(sw[k]) ? sw[k].value : null);

const tleResults = results.slice(0, TLE_GROUPS.length);
for (const r of tleResults) console.log(ok(r) ? `${r.value.stale ? 'WARN ' : ''}gp ${r.value.msg}` : `WARN gp ${r.reason.message}`);
const groups = tleResults.filter(ok).map(({ value: { msg, ...g } }) => g);
if (groups.length) await writeFile(join(DATA, 'gp', 'groups.json'), JSON.stringify(groups, null, 1));

// Ionosonde history: previous points + the current ones, deduplicated, last 36 h.
function ionoHistory(prev, current) {
  const hist = {};
  const cutoff = Date.now() - 36 * 3600e3;
  for (const [code, pts] of Object.entries(prev || {})) hist[code] = Array.isArray(pts) ? pts : [];
  for (const s of current || []) (hist[s.code] ||= []).push([s.time, s.foF2, s.mufd]);
  for (const code of Object.keys(hist)) {
    const seen = new Map();
    for (const p of hist[code]) if (Date.parse(p[0]) >= cutoff) seen.set(p[0], p);
    hist[code] = [...seen.values()].sort((a, b) => a[0].localeCompare(b[0]));
    if (!hist[code].length) delete hist[code];
  }
  return hist;
}

const spaceOk = Object.keys(SPACE).filter(k => ok(sw[k]));
if (spaceOk.length) {
  const kp = val('kp'), f107 = val('f107');
  const prop = {
    updated: new Date().toISOString(),
    kp: kp ? kp.latest.kp : null,
    kpTime: kp ? kp.latest.time : null,
    kpSeries: kp ? kp.series : [],
    sfi: f107 ? f107.sfi : null,
    sfiTime: f107 ? f107.sfiTime : null,
    sfi90: f107 ? f107.sfi90 : null,
    scales: val('scales'),
    xray: val('xray'),
    wind: val('wind'),
    ionosondes: val('iono') || [],
    ionoHistory: ionoHistory(prevProp && prevProp.ionoHistory, val('iono')),
    sources: {
      kp: 'NOAA SWPC planetary K index and 3-day forecast',
      sfi: 'NOAA SWPC / DRAO Penticton 10.7 cm flux',
      scales: 'NOAA SWPC space weather scales',
      xray: 'NOAA GOES primary X-ray sensor, 0.1-0.8 nm',
      wind: 'NOAA real-time solar wind (L1)',
      ionosondes: 'GIRO (Lowell DIDBase) via prop.kc2g.com',
    },
  };
  await writeFile(join(DATA, 'propagation.json'), JSON.stringify(prop));
  console.log(`propagation: Kp ${prop.kp ?? '-'}, SFI ${prop.sfi ?? '-'}, X-ray ${prop.xray ? prop.xray.flux.toExponential(1) : '-'}, Bz ${prop.wind?.bz ?? '-'}, ${prop.ionosondes.length} ionosonde(s), history for ${Object.keys(prop.ionoHistory).length}`);
}
for (const k of Object.keys(SPACE)) if (!ok(sw[k])) console.log(`WARN ${k}: ${sw[k].reason.message}`);

if (!spaceOk.length) {
  // Every space-weather source failed: keep the previous deploy's file, flagged as stale.
  if (prevProp) {
    prevProp.stale = true;
    await writeFile(join(DATA, 'propagation.json'), JSON.stringify(prevProp));
    console.log('WARN propagation: all sources failed, reusing previous deploy');
  } else {
    console.log('WARN propagation: all sources failed and no previous copy');
  }
}

if (results.every(r => !ok(r))) process.exit(1);
