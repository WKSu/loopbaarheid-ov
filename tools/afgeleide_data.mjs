#!/usr/bin/env node
/* ============================================================
   Afgeleide datablokken voor index.html (Invloedsgebied ov-haltes Rotterdam)

   Berekent uit de datablokken die al in index.html staan (d-data, d-scn, d-lijnen, d-buurt):
     d-lord   haltes per lijn in routevolgorde (projectie op de lijngeometrie)
     d-lterm  eindpunten per lijn uit de GTFS-routenaam (lijnen.sub), in dezelfde richting
     d-kd     loopafstand per pand tot de dichtstbijzijnde knoop (≤1600 m), afgestemd op de 1000 m-sets
     d-ds     doorsteekkansen: rechte verbindingen ≤110 m die geen gebouw kruisen, gerangschikt
              op het aantal adressen dat er ov-toegang door krijgt

   Draai dit opnieuw na elke nieuwe data-export (dienstregeling, netwerk, BAG):
     node tools/afgeleide_data.mjs [pad/naar/index.html]
   Het script schrijft de vier blokken terug in hetzelfde bestand. Node 18 of nieuwer.

   De netwerkberekening volgt de motor in index.html (snapEdge/seedsAt/dijkstra/pandDistMap),
   zodat een doorsteek die je met "→ doorrekenen" overneemt hetzelfde effect laat zien.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.html");
let html = fs.readFileSync(FILE, "utf8");
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

/* ---------- datablokken lezen en schrijven ---------- */
const tagOf = id => `<script id="${id}" type="application/json">`;
function block(id) {
  const a = html.indexOf(tagOf(id));
  if (a < 0) throw new Error(`blok ${id} ontbreekt in ${FILE}`);
  const s = a + tagOf(id).length, e = html.indexOf("</script>", s);
  return JSON.parse(html.slice(s, e));
}
function setBlock(id, obj) {
  const txt = JSON.stringify(obj);
  if (txt.includes("</script")) throw new Error(`blok ${id} bevat </script`);
  const tag = tagOf(id) + txt + "</script>";
  const a = html.indexOf(tagOf(id));
  if (a >= 0) {
    const e = html.indexOf("</script>", a) + "</script>".length;
    html = html.slice(0, a) + tag + html.slice(e);
  } else {
    const b = html.indexOf(tagOf("d-scn"));
    if (b < 0) throw new Error("blok d-scn ontbreekt: weet niet waar " + id + " moet komen");
    html = html.slice(0, b) + tag + "\n" + html.slice(b);
  }
}

const DATA = block("d-data"), SCN = block("d-scn"), LIJNEN = block("d-lijnen"), BUURT = block("d-buurt");
const H = DATA.haltes, LN = DATA.lijnen, NP = DATA.nvo.length;
const NVO = Int32Array.from(DATA.nvo), DHP = Uint8Array.from(DATA.dhp);
log(`${H.length} haltes, ${LN.length} lijnen, ${NP} panden, ${SCN.nnode} netwerkknopen`);

/* ---------- coördinaten (zelfde formules als index.html) ---------- */
function rd2wgs(x, y) {
  const dx = (x - 155000) * 1e-5, dy = (y - 463000) * 1e-5;
  const sl = [[0,1,3235.65389],[2,0,-32.58297],[0,2,-0.24750],[2,1,-0.84978],[0,3,-0.06550],
    [2,2,-0.01709],[1,0,-0.00738],[4,0,0.00530],[2,3,-0.00039],[4,1,0.00033],[1,1,-0.00012]];
  const so = [[1,0,5260.52916],[1,1,105.94684],[1,2,2.45656],[3,0,-0.81885],[1,3,0.05594],
    [3,1,-0.05607],[0,1,0.01199],[3,2,-0.00256],[1,4,0.00128],[0,2,0.00022],[2,0,-0.00022],[5,0,0.00026]];
  let lat = 52.15517440, lon = 5.38720621;
  for (const [p, q, c] of sl) lat += c * Math.pow(dx, p) * Math.pow(dy, q) / 3600;
  for (const [p, q, c] of so) lon += c * Math.pow(dx, p) * Math.pow(dy, q) / 3600;
  return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}
function wgs2rd(lon, lat) {
  const dphi = 0.36 * (lat - 52.15517440), dlam = 0.36 * (lon - 5.38720621);
  const R = [[0,1,190094.945],[1,1,-11832.228],[2,1,-114.221],[0,3,-32.391],[1,0,-0.705],
    [3,1,-2.340],[1,3,-0.608],[0,2,-0.008],[2,3,0.148]];
  const S = [[1,0,309056.544],[0,2,3638.893],[2,0,73.077],[1,2,-157.984],[3,0,59.788],
    [0,1,0.433],[2,2,-6.439],[1,1,-0.032],[0,4,0.092],[1,4,-0.054]];
  let x = 155000, y = 463000;
  for (const [p, q, c] of R) x += c * Math.pow(dphi, p) * Math.pow(dlam, q);
  for (const [p, q, c] of S) y += c * Math.pow(dphi, p) * Math.pow(dlam, q);
  return [x, y];
}

/* ---------- decoders ---------- */
const zz = v => (v & 1) ? -((v + 1) >> 1) : (v >> 1);
function decDelta(s) { // oplopende id's, delta base36 (inc500/inc1000)
  if (!s) return new Uint32Array(0);
  const p = s.split(","), o = new Uint32Array(p.length); let v = 0;
  for (let i = 0; i < p.length; i++) { v += parseInt(p[i], 36); o[i] = v; }
  return o;
}
function decZint(s) {
  const p = s.split(","), o = new Int32Array(p.length); let v = 0;
  for (let i = 0; i < p.length; i++) { v += zz(parseInt(p[i], 36)); o[i] = v; }
  return o;
}

/* ---------- voetgangersnetwerk (als build() in index.html) ---------- */
const B36S = s => { const a = s.split(","), o = new Int32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = parseInt(a[i], 36); return o; };
const dz = (s, scale) => { const a = s.split(","), o = new Float64Array(a.length); let p = 0;
  for (let i = 0; i < a.length; i++) { p += zz(parseInt(a[i], 36)); o[i] = p / scale; } return o; };
const N = SCN.nnode, X = dz(SCN.nx, 10), Y = dz(SCN.ny, 10);
const eu_ = dz(SCN.eu, 1), evr = B36S(SCN.ev), EL = B36S(SCN.el), EW = SCN.ew, M = evr.length;
const EU = new Int32Array(M), EV = new Int32Array(M);
for (let e = 0; e < M; e++) { EU[e] = eu_[e]; EV[e] = EU[e] + evr[e]; }
const deg = new Int32Array(N);
for (let e = 0; e < M; e++) { deg[EU[e]]++; deg[EV[e]]++; }
const head = new Int32Array(N + 1);
for (let i = 0; i < N; i++) head[i + 1] = head[i] + deg[i];
const nbr = new Int32Array(head[N]), w = new Float32Array(head[N]);
{ const cur = Int32Array.from(head.subarray(0, N));
  for (let e = 0; e < M; e++) { const a = EU[e], b = EV[e], L = EL[e] / 10;
    nbr[cur[a]] = b; w[cur[a]] = L; cur[a]++; nbr[cur[b]] = a; w[cur[b]] = L; cur[b]++; } }
// pand-toegangspunten
const KOFF = new Int32Array(NP + 1);
for (let i = 0; i < NP; i++) KOFF[i + 1] = KOFF[i] + (SCN.kcnt.charCodeAt(i) - 48);
const TOTK = KOFF[NP], KN = new Int32Array(TOTK), KC = new Float32Array(TOTK);
{ const KNs = SCN.kn.split(","); let pos = 0, prevfirst = 0;
  for (let i = 0; i < NP; i++) {
    const c = SCN.kcnt.charCodeAt(i) - 48; if (!c) continue;
    let cur2 = prevfirst + zz(parseInt(KNs[pos], 36)); KN[pos] = cur2; prevfirst = cur2;
    for (let k = 1; k < c; k++) { cur2 += parseInt(KNs[pos + k], 36); KN[pos + k] = cur2; }
    pos += c; }
  for (let k = 0; k < TOTK; k++) KC[k] = parseInt(SCN.kc.substr(2 * k, 2), 36); }
const nhead = new Int32Array(N + 1);
{ const nd = new Int32Array(N); for (let k = 0; k < TOTK; k++) nd[KN[k]]++;
  for (let i = 0; i < N; i++) nhead[i + 1] = nhead[i] + nd[i]; }
const npand = new Int32Array(nhead[N]);
{ const nc = Int32Array.from(nhead.subarray(0, N));
  for (let i = 0; i < NP; i++) for (let k = KOFF[i]; k < KOFF[i + 1]; k++) npand[nc[KN[k]]++] = i; }
const HQ = SCN.hq.map(a => { const q = []; for (let i = 0; i < a.length; i += 2) q.push([a[i] / 10, a[i + 1] / 10]); return q; });
// randen-grid (cel 70 m)
const CELL = 70; let minX = 1e15, minY = 1e15;
for (let i = 0; i < N; i++) { if (X[i] < minX) minX = X[i]; if (Y[i] < minY) minY = Y[i]; }
const gk = (cx, cy) => cx * 131072 + cy, grid = new Map();
for (let e = 0; e < M; e++) {
  const ax = X[EU[e]], ay = Y[EU[e]], bx = X[EV[e]], by = Y[EV[e]];
  const x0 = Math.floor((Math.min(ax, bx) - minX) / CELL), x1 = Math.floor((Math.max(ax, bx) - minX) / CELL);
  const y0 = Math.floor((Math.min(ay, by) - minY) / CELL), y1 = Math.floor((Math.max(ay, by) - minY) / CELL);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) { const k = gk(cx, cy); let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(e); }
}
log(`netwerk: ${N} knopen, ${M} randen`);

function snapEdge(px, py) {
  const cx = Math.floor((px - minX) / CELL), cy = Math.floor((py - minY) / CELL);
  let bE = -1, bD = 1e18, bF = 0, mE = -1, mD = 1e18, mF = 0;
  for (let R = 0; R <= 8; R++) {
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
      if (R > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== R) continue;
      const arr = grid.get(gk(cx + dx, cy + dy)); if (!arr) continue;
      for (const e of arr) {
        const ax = X[EU[e]], ay = Y[EU[e]], vx = X[EV[e]] - ax, vy = Y[EV[e]] - ay, L2 = vx * vx + vy * vy;
        let t = L2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dd = Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
        if (EW[e] === "1") { if (dd < bD) { bD = dd; bE = e; bF = t; } }
        else { if (dd < mD) { mD = dd; mE = e; mF = t; } }
      }
    }
    if (bE >= 0 && bD <= 60 && R >= 2) break;
    if ((bE >= 0 || mE >= 0) && R >= 6) break;
  }
  if (bE < 0 && mE < 0) return null;
  if (bE >= 0 && bD <= 60) return { e: bE, frac: bF, acc: bD };
  if (mE >= 0 && (bE < 0 || mD < bD)) return { e: mE, frac: mF, acc: mD };
  return bE >= 0 ? { e: bE, frac: bF, acc: bD } : { e: mE, frac: mF, acc: mD };
}
function seedsAt(px, py, C) {
  const sn = snapEdge(px, py); if (!sn) return null;
  const u = EU[sn.e], v = EV[sn.e];
  const seg = Math.hypot(X[v] - X[u], Y[v] - Y[u]), fr = sn.frac * seg, acc = Math.min(sn.acc, C);
  return [[u, acc + fr], [v, acc + (seg - fr)]];
}

/* binaire heap op (afstand, knoop) */
class Heap {
  constructor() { this.d = []; this.n = []; }
  get size() { return this.d.length; }
  push(dv, nv) { const d = this.d, n = this.n; d.push(dv); n.push(nv); let i = d.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (d[p] <= d[i]) break; [d[p], d[i]] = [d[i], d[p]]; [n[p], n[i]] = [n[i], n[p]]; i = p; } }
  pop() { const d = this.d, n = this.n, rd = d[0], rn = n[0], L = d.length - 1; d[0] = d[L]; n[0] = n[L]; d.pop(); n.pop();
    let i = 0; const S = d.length;
    for (;;) { let s = i; const l = 2 * i + 1, r = l + 1; if (l < S && d[l] < d[s]) s = l; if (r < S && d[r] < d[s]) s = r; if (s === i) break;
      [d[s], d[i]] = [d[i], d[s]]; [n[s], n[i]] = [n[i], n[s]]; i = s; }
    this.rd = rd; return rn; }
}
function dijkstra(seeds, C) {
  const dist = new Float64Array(N).fill(Infinity), hp = new Heap();
  for (const [n0, d0] of seeds) if (d0 < C && d0 < dist[n0]) { dist[n0] = d0; hp.push(d0, n0); }
  while (hp.size) {
    const x = hp.pop(), d = hp.rd; if (d > dist[x] || d >= C) continue;
    for (let k = head[x]; k < head[x + 1]; k++) { const y = nbr[k], nd = d + w[k]; if (nd < dist[y] && nd < C) { dist[y] = nd; hp.push(nd, y); } }
  }
  return dist;
}
function pandDist(dist) { // pand -> min over toegangspunten (dist + aanlooplengte)
  const out = new Float64Array(NP).fill(Infinity);
  for (let p = 0; p < NP; p++) for (let q = KOFF[p]; q < KOFF[p + 1]; q++) { const v = dist[KN[q]] + KC[q]; if (v < out[p]) out[p] = v; }
  return out;
}
function haltesSeeds(ids, C) {
  const s = [];
  for (const id of ids) for (const [qx, qy] of HQ[id]) { const sd = seedsAt(qx, qy, C); if (sd) s.push(...sd); }
  return s;
}

/* ============================================================
   1. d-lord + d-lterm: routevolgorde en eindpunten per lijn
   ============================================================ */
const M_LON = 111320 * Math.cos(51.92 * Math.PI / 180), M_LAT = 111320;
const LGEO = new Map(); for (const f of LIJNEN.features) LGEO.set(f.properties.i, f.geometry);
const LORD = {}, LTERM = {};
let lordStat = { lijnen: 0, verMax: 0, zonderGeo: 0 };
function polyOf(g) {
  const parts = g.type === "MultiLineString" ? g.coordinates : [g.coordinates];
  let best = null, bl = -1;
  for (const p of parts) { let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot((p[i][0] - p[i - 1][0]) * M_LON, (p[i][1] - p[i - 1][1]) * M_LAT); if (L > bl) { bl = L; best = p; } }
  return best.map(([lo, la]) => [lo * M_LON, la * M_LAT]);
}
function project(P, x, y) { // [booglengte, afstand]
  let acc = 0, bd = Infinity, bs = 0;
  for (let i = 0; i + 1 < P.length; i++) {
    const ax = P[i][0], ay = P[i][1], vx = P[i + 1][0] - ax, vy = P[i + 1][1] - ay, L2 = vx * vx + vy * vy, L = Math.sqrt(L2);
    let t = L2 > 0 ? ((x - ax) * vx + (y - ay) * vy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
    if (d < bd - 1e-9) { bd = d; bs = acc + t * L; }
    acc += L;
  }
  return [bs, bd];
}
function chainOrder(ids) { // zonder geometrie: keten vanaf het verste punt, steeds de dichtstbijzijnde volgende
  const pt = id => [H[id].lon * M_LON, H[id].lat * M_LAT];
  let a = ids[0], far = -1;
  for (const i of ids) for (const j of ids) { const [x1, y1] = pt(i), [x2, y2] = pt(j), d = Math.hypot(x1 - x2, y1 - y2); if (d > far) { far = d; a = i; } }
  const out = [a], left = new Set(ids); left.delete(a);
  while (left.size) { const [x, y] = pt(out[out.length - 1]); let b = null, bd = Infinity;
    for (const j of left) { const [x2, y2] = pt(j), d = Math.hypot(x - x2, y - y2); if (d < bd) { bd = d; b = j; } }
    out.push(b); left.delete(b); }
  return out;
}
const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(t => t.length > 2 && !["station", "metro", "rotterdam", "busstation", "centrum"].includes(t));
function sim(a, b) { const A = new Set(norm(a)), B = norm(b); let n = 0; for (const t of B) if (A.has(t)) n++; return n; }
function terminals(sub) {
  if (!sub || sub.includes("<->")) return null;
  const parts = sub.split(/\s+-\s*|\s*-\s+/).map(s => s.replace(/\s+via\s+.*$/i, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  return parts.length >= 2 ? [parts[0], parts[parts.length - 1]] : null;
}
LN.forEach((l, li) => {
  const ids = [...new Set(l.stops)];
  if (ids.length < 2) { LORD[li] = ids; return; }
  let ord;
  const g = LGEO.get(li);
  if (g) {
    const P = polyOf(g);
    const pr = ids.map(id => { const [s, d] = project(P, H[id].lon * M_LON, H[id].lat * M_LAT); lordStat.verMax = Math.max(lordStat.verMax, l.mode === "trein" ? 0 : d); return [id, s]; });
    pr.sort((a, b) => a[1] - b[1]);
    ord = pr.map(x => x[0]);
  } else { ord = chainOrder(ids); lordStat.zonderGeo++; }
  const T = terminals(l.sub);
  if (T) { // routevolgorde laten lopen van het eerstgenoemde eindpunt naar het laatste
    const f = H[ord[0]].n, z = H[ord[ord.length - 1]].n;
    if (sim(T[0], z) + sim(T[1], f) > sim(T[0], f) + sim(T[1], z)) ord.reverse();
    LTERM[li] = T;
  }
  LORD[li] = ord; lordStat.lijnen++;
});
log(`d-lord: ${lordStat.lijnen} lijnen geordend (${lordStat.zonderGeo} zonder geometrie, grootste afstand halte–lijn ${Math.round(lordStat.verMax)} m); d-lterm: ${Object.keys(LTERM).length} lijnen`);

/* ============================================================
   2. dekking volgens de bouwpijplijn (inc500 / inc1000) en eigen netwerkvelden
   ============================================================ */
const covPipe = new Uint8Array(NP);
for (const h of H) for (const p of decDelta(DATA.inc500[h.id])) covPipe[p] = 1;
const K1000 = new Uint8Array(NP);
for (const k in DATA.inc1000) for (const p of decDelta(DATA.inc1000[k])) { covPipe[p] = 1; K1000[p] = 1; }
const knopen = H.filter(h => h.k).map(h => h.id);
log(`knopen: ${knopen.map(id => H[id].n).join(", ")}`);

const CAP = 1700;
const D = dijkstra(haltesSeeds(H.map(h => h.id), CAP), CAP);   // afstand tot dichtstbijzijnde halte
const DK = dijkstra(haltesSeeds(knopen, CAP), CAP);             // afstand tot dichtstbijzijnde knoop
const PD = pandDist(D), PDK = pandDist(DK);
const covMine = new Uint8Array(NP);
let agree = 0, nd = 0;
for (let p = 0; p < NP; p++) { covMine[p] = PD[p] <= 500 || PDK[p] <= 1000 ? 1 : 0; if (DHP[p] && NVO[p]) { nd += NVO[p]; if (covMine[p] === covPipe[p]) agree += NVO[p]; } }
log(`dekking eigen netwerkberekening vs bouwpijplijn: ${(100 * agree / nd).toFixed(2)}% van de adressen gelijk`);

/* ============================================================
   3. d-kd: loopafstand per pand tot de dichtstbijzijnde knoop, afgestemd op de 1000 m-sets
   ============================================================ */
{
  let up = 0, down = 0; const dev = [];
  const kd = new Int32Array(NP).fill(-1);
  for (let p = 0; p < NP; p++) {
    let v = PDK[p];
    if (K1000[p] && !(v < 1000)) { dev.push(Math.min(v, CAP) - 1000); v = 990; up++; }   // in de 1000 m-set: telt bij de norm mee
    else if (!K1000[p] && v < 1000) { dev.push(v - 1000); v = 1000; down++; }            // niet in de set: valt bij de norm buiten
    if (v <= 1600) kd[p] = Math.min(160, Math.round(v / 10));
  }
  // Math.round kan 995–999 m naar 1000 afronden: houd de set-grens exact
  for (let p = 0; p < NP; p++) if (kd[p] >= 0) { if (K1000[p] && kd[p] >= 100) kd[p] = 99; if (!K1000[p] && kd[p] < 100) kd[p] = 100; }
  const I = [], Dd = []; let prev = 0;
  for (let p = 0; p < NP; p++) if (kd[p] >= 0) { I.push((p - prev).toString(36)); Dd.push(kd[p].toString(36).padStart(2, "0")); prev = p; }
  setBlock("d-kd", { i: I.join(","), d: Dd.join("") });
  dev.sort((a, b) => a - b);
  const q = f => dev.length ? Math.round(dev[Math.min(dev.length - 1, Math.floor(f * dev.length))]) : 0;
  log(`d-kd: ${I.length} panden ≤1600 m van een knoop; bijgesteld naar de 1000 m-sets: ${up} omhoog, ${down} omlaag ` +
    `(afwijking t.o.v. 1000 m: p10 ${q(.1)} · mediaan ${q(.5)} · p90 ${q(.9)} m)`);
}

/* ============================================================
   4. d-ds: doorsteekkansen
   ============================================================ */
const LMAX = 110, LMIN = 12, NSUGG = 15, MINGAIN = 25;
// pand-centroïden (RD) en gebouwranden voor de kruisingstoets
const PXl = decZint(DATA.px), PYl = decZint(DATA.py);
const PRX = new Float64Array(NP), PRY = new Float64Array(NP);
for (let p = 0; p < NP; p++) { const [x, y] = wgs2rd(PXl[p] / 1e5, PYl[p] / 1e5); PRX[p] = x; PRY[p] = y; }
const BCELL = 40, bgrid = new Map(); const BE = []; // [x1,y1,x2,y2]
{
  const parts = DATA.qg.split("|"); let px = 0, py = 0;
  for (const part of parts) {
    const pts = part.split(","), ring = []; let lx = px, ly = py;
    for (const t of pts) { const d = t.split("."); lx += zz(parseInt(d[0], 36)); ly += zz(parseInt(d[1], 36)); ring.push([lx, ly]); }
    px = ring[0][0]; py = ring[0][1];
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length], k = BE.length / 4;
      BE.push(x1, y1, x2, y2);
      const cx0 = Math.floor(Math.min(x1, x2) / BCELL), cx1 = Math.floor(Math.max(x1, x2) / BCELL);
      const cy0 = Math.floor(Math.min(y1, y2) / BCELL), cy1 = Math.floor(Math.max(y1, y2) / BCELL);
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) { const key = cx * 131072 + cy; let a = bgrid.get(key); if (!a) { a = []; bgrid.set(key, a); } a.push(k); }
    }
  }
}
log(`gebouwranden: ${BE.length / 4}`);
function segX(ax, ay, bx, by, cx, cy, dx, dy) { // echte kruising (geen raken)
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(ax, ay, bx, by, cx, cy) * o(ax, ay, bx, by, dx, dy) < 0 && o(cx, cy, dx, dy, ax, ay) * o(cx, cy, dx, dy, bx, by) < 0;
}
function crossesBuilding(ax, ay, bx, by) {
  const cx0 = Math.floor(Math.min(ax, bx) / BCELL), cx1 = Math.floor(Math.max(ax, bx) / BCELL);
  const cy0 = Math.floor(Math.min(ay, by) / BCELL), cy1 = Math.floor(Math.max(ay, by) / BCELL);
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    const a = bgrid.get(cx * 131072 + cy); if (!a) continue;
    for (const k of a) { const j = 4 * k; if (segX(ax, ay, bx, by, BE[j], BE[j + 1], BE[j + 2], BE[j + 3])) return true; }
  }
  return false;
}
// knopen-grid (voor kandidaat-partners binnen 110 m)
const NCELL = LMAX, ngrid = new Map();
for (let n = 0; n < N; n++) { const k = Math.floor((X[n] - minX) / NCELL) * 131072 + Math.floor((Y[n] - minY) / NCELL); let a = ngrid.get(k); if (!a) { a = []; ngrid.set(k, a); } a.push(n); }
// grid van adressen zonder ov-toegang (voorfilter: alleen zoeken waar iets te winnen valt)
const UCELL = 100, ugrid = new Map();
for (let p = 0; p < NP; p++) if (DHP[p] && NVO[p] && !covPipe[p] && !covMine[p]) { const k = Math.floor(PRX[p] / UCELL) * 131072 + Math.floor(PRY[p] / UCELL); let a = ugrid.get(k); if (!a) { a = []; ugrid.set(k, a); } a.push(p); }
function uncoveredNear(x, y, r) {
  const c0 = Math.floor((x - r) / UCELL), c1 = Math.floor((x + r) / UCELL), d0 = Math.floor((y - r) / UCELL), d1 = Math.floor((y + r) / UCELL);
  for (let cx = c0; cx <= c1; cx++) for (let cy = d0; cy <= d1; cy++) { const a = ugrid.get(cx * 131072 + cy); if (!a) continue;
    for (const p of a) if (Math.hypot(PRX[p] - x, PRY[p] - y) <= r) return true; }
  return false;
}

// 4a. kandidaten: per knoop de beste partner binnen 110 m die de afstand tot een halte flink verkort
const cands = [];
for (let a = 0; a < N; a++) {
  if (!(D[a] > LMIN + 60)) continue;
  const cx = Math.floor((X[a] - minX) / NCELL), cy = Math.floor((Y[a] - minY) / NCELL), opts = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const arr = ngrid.get((cx + dx) * 131072 + cy + dy); if (!arr) continue;
    for (const b of arr) {
      const L = Math.hypot(X[b] - X[a], Y[b] - Y[a]);
      if (L < LMIN || L > LMAX) continue;
      const nv = D[b] + L;
      if (nv < 500 && nv + 60 < D[a]) opts.push([nv, b, L]);
    }
  }
  if (!opts.length) continue;
  opts.sort((p, q) => p[0] - q[0]);
  for (const [nv, b, L] of opts.slice(0, 8)) {
    if (!uncoveredNear(X[a], Y[a], 500 - nv)) break;
    if (crossesBuilding(X[a], Y[a], X[b], Y[b])) continue;
    cands.push({ a, b, L }); break;
  }
}
log(`doorsteken: ${cands.length} kandidaten`);

// 4b. effect per kandidaat: lokale herberekening van de afstandsvelden met de nieuwe verbinding
function improve(F, a, b, L, cap) {
  const nd = new Map(), hp = new Heap();
  const seed = (n, v) => { if (v < F[n] && v < cap && v < (nd.get(n) ?? Infinity)) { nd.set(n, v); hp.push(v, n); } };
  seed(a, F[b] + L); seed(b, F[a] + L);
  while (hp.size) {
    const x = hp.pop(), d = hp.rd; if (d > nd.get(x)) continue;
    for (let k = head[x]; k < head[x + 1]; k++) { const y = nbr[k], v = d + w[k];
      if (v < cap && v < F[y] && v < (nd.get(y) ?? Infinity)) { nd.set(y, v); hp.push(v, y); } }
  }
  return nd;
}
function effect(c) {
  const n1 = improve(D, c.a, c.b, c.L, 900), n2 = improve(DK, c.a, c.b, c.L, 1000);
  const ps = new Set();
  for (const m of [n1, n2]) for (const n of m.keys()) for (let k = nhead[n]; k < nhead[n + 1]; k++) ps.add(npand[k]);
  let gain = 0, kort = 0, red = 0; const gp = [];
  for (const p of ps) {
    if (!DHP[p] || !NVO[p]) continue;
    let d1 = Infinity, k1 = Infinity;
    for (let q = KOFF[p]; q < KOFF[p + 1]; q++) {
      const v = (n1.get(KN[q]) ?? D[KN[q]]) + KC[q]; if (v < d1) d1 = v;
      const u = (n2.get(KN[q]) ?? DK[KN[q]]) + KC[q]; if (u < k1) k1 = u;
    }
    if (!covPipe[p] && !covMine[p] && (d1 <= 500 || k1 <= 1000)) { gain += NVO[p]; gp.push(p); }
    const d0 = Math.min(PD[p], CAP);
    if (d1 <= 800 && d1 < d0 - 10) { kort += NVO[p]; red += (d0 - d1) * NVO[p]; }
  }
  return { gain, kort, gem: kort ? Math.round(red / kort) : 0, gp };
}
const scored = [];
for (const c of cands) { const e = effect(c); if (e.gain >= MINGAIN) scored.push({ ...c, ...e }); }
scored.sort((p, q) => q.gain - p.gain || q.kort - p.kort);
log(`doorsteken: ${scored.length} kandidaten met ≥${MINGAIN} adressen winst`);

// 4c. selectie: grootste winst eerst, geen twee voorstellen voor dezelfde plek of dezelfde adressen
const PB = DATA.pb, NB = BUURT.features.length, BNAAM = [];
for (const f of BUURT.features) BNAAM[f.properties.i] = f.properties.n;
const taken = new Set(), DS = [];
for (const s of scored) {
  if (DS.length >= NSUGG) break;
  const mx = (X[s.a] + X[s.b]) / 2, my = (Y[s.a] + Y[s.b]) / 2;
  if (DS.some(t => Math.hypot(t._x - mx, t._y - my) < 300)) continue;
  let ov = 0; for (const p of s.gp) if (taken.has(p)) ov += NVO[p];
  if (ov > 0.3 * s.gain) continue;
  for (const p of s.gp) taken.add(p);
  // huidige omweg over het netwerk tussen de twee eindpunten
  const dn = dijkstra([[s.a, 0]], 3000)[s.b];
  // buurt: waar de meeste gewonnen adressen liggen
  const bc = new Map(); for (const p of s.gp) { const b = parseInt(PB.substr(2 * p, 2), 36); if (b < NB) bc.set(b, (bc.get(b) || 0) + NVO[p]); }
  const bb = [...bc.entries()].sort((p, q) => q[1] - p[1])[0];
  DS.push({ na: s.a, nb: s.b, len: Math.round(s.L), gain: s.gain, kort: s.kort, gem: s.gem, net: Number.isFinite(dn) ? Math.round(dn / 10) * 10 : 0,
    a: rd2wgs(X[s.a], Y[s.a]), b: rd2wgs(X[s.b], Y[s.b]), buurt: bb ? BNAAM[bb[0]] : "", p: s.gp.sort((p, q) => p - q), _x: mx, _y: my });
}
for (const d of DS) { delete d._x; delete d._y; }
setBlock("d-ds", DS);
log(`d-ds: ${DS.length} doorsteken: ` + DS.map(d => `${d.buurt} +${d.gain}`).join(" · "));

setBlock("d-lord", LORD);
setBlock("d-lterm", LTERM);
fs.writeFileSync(FILE, html);
log(`geschreven: ${FILE}`);
