import { useState, useRef, useEffect } from "react";
import {
  MousePointer2,
  Minus,
  Zap,
  BatteryFull,
  Pause,
  Magnet,
  Waves,
  Lightbulb,
  ToggleLeft,
  ArrowDownToLine,
  Trash2,
  Eraser,
  Play,
} from "lucide-react";

/* ---------------------------------------------------------------------- */
/*  Constants                                                              */
/* ---------------------------------------------------------------------- */

const GRID = 20;
const W = 480;
const H = 360;
const FIXED_DT = 0.002; // internal physics timestep (seconds of simulated time)
const MAX_STEPS_PER_FRAME = 150; // guards against a huge catch-up burst after the tab was backgrounded
const HISTORY_WINDOW = 4; // seconds of simulated time kept for the scope trace

const TOOLS = [
  { type: "select", label: "Select", icon: MousePointer2 },
  { type: "wire", label: "Wire", icon: Minus },
  { type: "resistor", label: "Resistor", icon: Zap },
  { type: "capacitor", label: "Cap", icon: Pause },
  { type: "inductor", label: "Inductor", icon: Magnet },
  { type: "battery", label: "Battery", icon: BatteryFull },
  { type: "acsource", label: "AC Src", icon: Waves },
  { type: "led", label: "LED", icon: Lightbulb },
  { type: "switch", label: "Switch", icon: ToggleLeft },
  { type: "ground", label: "Ground", icon: ArrowDownToLine },
  { type: "delete", label: "Erase", icon: Trash2 },
];

const SPEED_OPTIONS = [0.1, 0.25, 0.5, 1, 2, 5];

// Real schematic reference-designator prefixes. Ground and wire aren't
// individually labeled on real schematics, so they're left out.
const DESIGNATOR_PREFIX = {
  resistor: "R",
  capacitor: "C",
  inductor: "L",
  battery: "BT",
  acsource: "V",
  led: "D",
  switch: "SW",
};

function computeDesignatorCounts(parts) {
  const counts = {};
  parts.forEach((p) => {
    if (!p.designator) return;
    const prefix = DESIGNATOR_PREFIX[p.type];
    if (!prefix || !p.designator.startsWith(prefix)) return;
    const num = parseInt(p.designator.slice(prefix.length), 10);
    if (!isNaN(num)) counts[p.type] = Math.max(counts[p.type] || 0, num);
  });
  return counts;
}

const EXAMPLES = {
  led: {
    name: "LED circuit",
    parts: [
      { id: "c1", type: "battery", x1: 80, y1: 280, x2: 80, y2: 100, value: 5, designator: "BT1" },
      { id: "c2", type: "wire", points: [{ x: 80, y: 100 }, { x: 280, y: 100 }] },
      { id: "c3", type: "switch", x1: 280, y1: 100, x2: 380, y2: 100, closed: true, designator: "SW1" },
      { id: "c4", type: "resistor", x1: 380, y1: 100, x2: 380, y2: 280, value: 330, designator: "R1" },
      { id: "c5", type: "led", x1: 380, y1: 280, x2: 180, y2: 280, designator: "D1" },
      { id: "c6", type: "wire", points: [{ x: 180, y: 280 }, { x: 80, y: 280 }] },
      { id: "c7", type: "ground", x1: 80, y1: 280 },
    ],
  },
  rc: {
    name: "RC charging",
    parts: [
      { id: "c1", type: "battery", x1: 80, y1: 280, x2: 80, y2: 100, value: 5, designator: "BT1" },
      { id: "c2", type: "wire", points: [{ x: 80, y: 100 }, { x: 280, y: 100 }] },
      { id: "c3", type: "switch", x1: 280, y1: 100, x2: 380, y2: 100, closed: false, designator: "SW1" },
      { id: "c4", type: "resistor", x1: 380, y1: 100, x2: 380, y2: 280, value: 10000, designator: "R1" },
      { id: "c5", type: "capacitor", x1: 380, y1: 280, x2: 180, y2: 280, value: 200, designator: "C1" },
      { id: "c6", type: "wire", points: [{ x: 180, y: 280 }, { x: 80, y: 280 }] },
      { id: "c7", type: "ground", x1: 80, y1: 280 },
    ],
  },
};

/* ---------------------------------------------------------------------- */
/*  Circuit solver — modified nodal analysis with backward-Euler           */
/*  companion models for capacitors/inductors, run every physics tick      */
/* ---------------------------------------------------------------------- */

function key(x, y) {
  return `${x},${y}`;
}

function solveLinear(A, b) {
  const n = b.length;
  if (n === 0) return [];
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[maxRow][col])) maxRow = r;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];
    [b[col], b[maxRow]] = [b[maxRow], b[col]];
    const piv = A[col][col];
    if (Math.abs(piv) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = A[r][col] / piv;
      if (factor === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= factor * A[col][c];
      b[r] -= factor * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) x[i] = Math.abs(A[i][i]) < 1e-12 ? 0 : b[i] / A[i][i];
  return x;
}

// LED companion model: a damped fixed-point iteration toward a smooth
// (sigmoid) conductance curve as a function of the voltage across it. A hard
// on/off resistance switch oscillates forever once it crosses the threshold
// each pass (verified empirically) — damping the conductance update is what
// actually converges to a stable operating point.
const LED_VF = 1.7;
const LED_RON = 15;
const LED_ROFF = 5e7;
const LED_STEEPNESS = 6;
const LED_DAMP = 0.15;
const LED_MAX_ITER = 50;

function ledTargetG(v) {
  const gon = 1 / LED_RON;
  const goff = 1 / LED_ROFF;
  const s = 1 / (1 + Math.exp(-(v - LED_VF) * LED_STEEPNESS));
  return goff + (gon - goff) * s;
}

/* ---------------------------------------------------------------------- */
/*  Multi-point wire geometry                                              */
/*  Wires are the only component that can bend; everything else keeps a    */
/*  fixed 2-terminal body. componentPoints() gives a uniform view of any   */
/*  part's path for node-collection and crossing detection. expandForSolver*/
/*  turns a bent wire into several synthetic 2-point wire segments so the  */
/*  solver above never has to know multi-point wires exist.                */
/* ---------------------------------------------------------------------- */

function componentPoints(c) {
  if (c.type === "wire") return c.points;
  if (c.type === "ground") return [{ x: c.x1, y: c.y1 }];
  return [
    { x: c.x1, y: c.y1 },
    { x: c.x2, y: c.y2 },
  ];
}

function expandForSolver(components) {
  const expanded = [];
  components.forEach((c) => {
    if (c.type === "wire") {
      for (let i = 0; i < c.points.length - 1; i++) {
        expanded.push({
          id: `${c.id}#${i}`,
          type: "wire",
          x1: c.points[i].x,
          y1: c.points[i].y,
          x2: c.points[i + 1].x,
          y2: c.points[i + 1].y,
        });
      }
    } else {
      expanded.push(c);
    }
  });
  return expanded;
}

// Standard 2D segment intersection. Returns the crossing point plus how far
// along each segment it falls (t, u in [0,1]), or null if they don't cross.
// A crossing within EPS of either segment's own endpoint is treated as "no
// crossing" — that's a shared node / real junction, not an ambiguous cross,
// and junctions are already shown via the colored node dots.
const HOP_EPS = 0.02;
function segIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x,
    d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x,
    d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null; // parallel or collinear
  const dx = p3.x - p1.x,
    dy = p3.y - p1.y;
  const t = (dx * d2y - dy * d2x) / denom;
  const u = (dx * d1y - dy * d1x) / denom;
  if (t <= HOP_EPS || t >= 1 - HOP_EPS || u <= HOP_EPS || u >= 1 - HOP_EPS) return null;
  return { t, u, x: p1.x + t * d1x, y: p1.y + t * d1y };
}

// Flattens every component into its constituent line segments, finds true
// mid-segment crossings between segments from DIFFERENT components, and
// decides which side of each crossing gets drawn with a hop. Rule: a wire
// always hops over a non-wire part (never deform a resistor/LED/etc.'s
// symbol); between two wires, the later one in iteration order hops. Only
// wire segments ever end up as keys, since only wires render with a
// hop-capable path.
function computeHops(components) {
  const segs = [];
  components.forEach((c) => {
    const pts = componentPoints(c);
    for (let i = 0; i < pts.length - 1; i++) {
      segs.push({ compId: c.id, segIdx: i, isWire: c.type === "wire", p1: pts[i], p2: pts[i + 1] });
    }
  });

  const hops = new Map(); // "compId:segIdx" -> [t, ...]
  const addHop = (seg, t) => {
    const k = `${seg.compId}:${seg.segIdx}`;
    if (!hops.has(k)) hops.set(k, []);
    hops.get(k).push(t);
  };

  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i];
      const b = segs[j];
      if (a.compId === b.compId) continue; // a wire's own consecutive segments always share an endpoint, never a true cross
      const hit = segIntersect(a.p1, a.p2, b.p1, b.p2);
      if (!hit) continue;
      if (a.isWire && b.isWire) {
        addHop(b, hit.u); // later one (by iteration order) hops
      } else if (a.isWire) {
        addHop(a, hit.t);
      } else if (b.isWire) {
        addHop(b, hit.u);
      }
      // neither is a wire: no good place to draw a hop without deforming a
      // symbol, so leave both straight — a rare, unhandled edge case.
    }
  }
  hops.forEach((arr) => arr.sort((x, y) => x - y));
  return hops;
}

// Advances the circuit by one fixed timestep. Capacitors/inductors carry
// memory (capV/indI) forward from prevState using backward-Euler companion
// models — verified against analytical RC/RL/LC/AC solutions. Wires, closed
// switches, and grounds are modeled as large fixed conductances rather than
// merged nodes, so every element gets the same uniform edge treatment.
function stepTransient(rawComponents, prevState, t, dt) {
  if (rawComponents.length === 0) {
    return { voltages: {}, currents: {}, ledOn: {}, newState: { capV: {}, indI: {} } };
  }
  // Bent wires become several synthetic 2-point wire segments here, so
  // everything below this line only ever deals with plain 2-terminal edges,
  // exactly like before multi-point wires existed.
  const components = expandForSolver(rawComponents);

  const hasGround = components.some((c) => c.type === "ground");
  const refKey = hasGround ? "__GND__" : key(components[0].x1, components[0].y1);

  const nodeSet = new Set();
  components.forEach((c) => {
    nodeSet.add(key(c.x1, c.y1));
    if (c.type !== "ground") nodeSet.add(key(c.x2, c.y2));
  });
  if (hasGround) nodeSet.add("__GND__");

  const nodeKeys = [...nodeSet].filter((k) => k !== refKey);
  const idx = new Map(nodeKeys.map((k, i) => [k, i]));
  const nIndex = (k) => (k === refKey ? -1 : idx.get(k));

  const n = nodeKeys.length;
  const sources = components.filter((c) => c.type === "battery" || c.type === "acsource");
  const m = sources.length;
  const size = n + m;

  const leds = components.filter((c) => c.type === "led");
  const ledG = {};
  leds.forEach((c) => (ledG[c.id] = 1 / LED_ROFF));

  const capV = prevState.capV || {};
  const indI = prevState.indI || {};

  let voltages = {};
  let sourceCurrents = {};
  const maxIter = leds.length ? LED_MAX_ITER : 1;

  for (let iter = 0; iter < maxIter; iter++) {
    const A = Array.from({ length: size }, () => new Array(size).fill(0));
    const b = new Array(size).fill(0);
    for (let i = 0; i < n; i++) A[i][i] += 1e-9; // leak to reference, avoids a singular matrix for floating loops

    components.forEach((c) => {
      let g = null;
      if (c.type === "resistor") g = 1 / Math.max(0.01, c.value);
      else if (c.type === "wire") g = 1000;
      else if (c.type === "switch" && c.closed) g = 1000;
      else if (c.type === "ground") g = 1000;
      else if (c.type === "capacitor") g = Math.max(1e-9, c.value * 1e-6) / dt;
      else if (c.type === "inductor") g = dt / Math.max(1e-9, c.value * 1e-3);
      else if (c.type === "led") g = ledG[c.id];
      if (g == null) return;

      const bKeyStr = c.type === "ground" ? "__GND__" : key(c.x2, c.y2);
      const ia = nIndex(key(c.x1, c.y1));
      const ib = nIndex(bKeyStr);
      if (ia >= 0) A[ia][ia] += g;
      if (ib >= 0) A[ib][ib] += g;
      if (ia >= 0 && ib >= 0) {
        A[ia][ib] -= g;
        A[ib][ia] -= g;
      }

      if (c.type === "capacitor") {
        const vPrev = capV[c.id] || 0;
        const Ieq = g * vPrev;
        if (ia >= 0) b[ia] += Ieq;
        if (ib >= 0) b[ib] -= Ieq;
      } else if (c.type === "inductor") {
        const iPrev = indI[c.id] || 0;
        if (ib >= 0) b[ib] += iPrev;
        if (ia >= 0) b[ia] -= iPrev;
      }
    });

    sources.forEach((s, si) => {
      const row = n + si;
      const val = s.type === "battery" ? s.value : s.amplitude * Math.sin(2 * Math.PI * s.freq * t);
      const ip = nIndex(key(s.x2, s.y2)); // second click = "+"
      const im = nIndex(key(s.x1, s.y1)); // first click = "-"
      if (ip >= 0) {
        A[ip][row] += 1;
        A[row][ip] += 1;
      }
      if (im >= 0) {
        A[im][row] -= 1;
        A[row][im] -= 1;
      }
      b[row] = val;
    });

    const x = solveLinear(A, b);
    voltages = {};
    nodeKeys.forEach((k, i) => (voltages[k] = x[i]));
    voltages[refKey] = 0;
    sourceCurrents = {};
    sources.forEach((s, si) => (sourceCurrents[s.id] = x[n + si]));

    let maxDelta = 0;
    leds.forEach((c) => {
      const va = voltages[key(c.x1, c.y1)] ?? 0;
      const vb = voltages[key(c.x2, c.y2)] ?? 0;
      const target = ledTargetG(va - vb);
      const oldG = ledG[c.id];
      const newG = oldG + LED_DAMP * (target - oldG);
      maxDelta = Math.max(maxDelta, Math.abs(newG - oldG) / Math.max(oldG, 1e-9));
      ledG[c.id] = newG;
    });
    if (leds.length === 0 || maxDelta < 1e-6) break;
  }

  const currents = {};
  const newCapV = { ...capV };
  const newIndI = { ...indI };
  components.forEach((c) => {
    const va = voltages[key(c.x1, c.y1)] ?? 0;
    const vb = c.type === "ground" ? 0 : voltages[key(c.x2, c.y2)] ?? 0;
    if (c.type === "resistor") {
      currents[c.id] = (va - vb) / Math.max(0.01, c.value);
    } else if (c.type === "wire") {
      currents[c.id] = (va - vb) * 1000;
    } else if (c.type === "switch") {
      currents[c.id] = c.closed ? (va - vb) * 1000 : 0;
    } else if (c.type === "led") {
      currents[c.id] = (va - vb) * ledG[c.id];
    } else if (c.type === "capacitor") {
      const g = Math.max(1e-9, c.value * 1e-6) / dt;
      const vPrev = capV[c.id] || 0;
      currents[c.id] = g * (va - vb) - g * vPrev;
      newCapV[c.id] = va - vb;
    } else if (c.type === "inductor") {
      const g = dt / Math.max(1e-9, c.value * 1e-3);
      const iPrev = indI[c.id] || 0;
      currents[c.id] = g * (va - vb) + iPrev;
      newIndI[c.id] = currents[c.id];
    } else if (c.type === "battery" || c.type === "acsource") {
      // MNA's source-current unknown is defined flowing + -> - through the
      // source; negate so the sign matches every other edge's point1->point2
      // convention, keeping the flow-dash direction consistent around a loop.
      currents[c.id] = -(sourceCurrents[c.id] || 0);
    } else {
      currents[c.id] = 0;
    }
  });

  const ledOn = {};
  leds.forEach((c) => (ledOn[c.id] = Math.abs(currents[c.id]) > 0.001));

  // The main loop above only ever populates synthetic per-segment ids
  // (e.g. "c2#0") for wires, since it iterates the expanded list — map one
  // representative current back onto the wire's own id for everything else
  // (inspector, scope, flow animation) to read.
  rawComponents.forEach((c) => {
    if (c.type === "wire") {
      currents[c.id] = currents[`${c.id}#0`];
    }
  });

  return { voltages, currents, ledOn, newState: { capV: newCapV, indI: newIndI } };
}

/* ---------------------------------------------------------------------- */
/*  Formatting / helpers                                                   */
/* ---------------------------------------------------------------------- */

function round2(n) {
  return Math.round(n * 100) / 100;
}
function fmtR(v) {
  if (v >= 1e6) return round2(v / 1e6) + " M\u03A9";
  if (v >= 1e3) return round2(v / 1e3) + " k\u03A9";
  return round2(v) + " \u03A9";
}
function fmtV(v) {
  return (isFinite(v) ? v : 0).toFixed(2) + " V";
}
function fmtI(a) {
  const mA = (isFinite(a) ? a : 0) * 1000;
  return (Math.abs(mA) < 0.005 ? 0 : mA).toFixed(2) + " mA";
}
function fmtC(v) {
  if (v >= 1000) return round2(v / 1000) + " mF";
  return round2(v) + " \u00B5F";
}
function fmtL(v) {
  if (v >= 1000) return round2(v / 1000) + " H";
  return round2(v) + " mH";
}
function fmtHz(v) {
  return round2(v) + " Hz";
}

function voltageColor(v) {
  const t = Math.max(-1, Math.min(1, v / 6));
  const NEU = [96, 96, 96]; // matches --volt-zero
  const POS = [204, 0, 0]; // matches --volt-pos
  const NEG = [0, 0, 204]; // matches --volt-neg
  const target = t >= 0 ? POS : NEG;
  const amt = Math.abs(t);
  const c = NEU.map((n0, i) => Math.round(n0 + (target[i] - n0) * amt));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function flowDuration(current) {
  const mag = Math.min(60, Math.max(0.3, Math.abs(current) * 1000));
  return Math.min(3.2, 2.4 / Math.sqrt(mag));
}

function snap(v, max) {
  return Math.max(0, Math.min(max, Math.round(v / GRID) * GRID));
}

function getSvgPoint(evt, svg) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

/* ---------------------------------------------------------------------- */
/*  Styling                                                                 */
/* ---------------------------------------------------------------------- */

const CSS = `
:root{
  --face:#C0C0C0; --face-light:#FFFFFF; --face-shadow:#808080; --face-dark:#404040;
  --canvas:#FFFFFF; --readout:#FFFFFF; --ink:#000000;
  --text:#000000; --text-muted:#404040; --text-dim:#808080;
  --accent:#000080; --accent-text:#FFFFFF; --danger:#CC0000;
  --flow:#008A00;
  --volt-pos:#CC0000; --volt-neg:#0000CC; --volt-zero:#606060;
  --grid-line:#E0E0E0; --grid-line-major:#BFBFBF;
  --font-ui:Tahoma,"MS Sans Serif",Arial,Helvetica,sans-serif;
  --font-mono:"Courier New",Consolas,monospace;
}
.csim-shell{ width:100%; height:100%; min-height:700px; background:var(--face); color:var(--text);
  font-family:var(--font-ui); display:flex; flex-direction:column; border-radius:0; overflow:hidden;
  border:1px solid var(--face-dark); }
.csim-header{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:6px 10px;
  background:var(--face); border-bottom:1px solid var(--face-dark); flex-shrink:0; flex-wrap:wrap; }
.csim-brand{ display:flex; align-items:baseline; gap:7px; }
.csim-mark{ color:var(--accent); font-size:14px; line-height:1; }
.csim-title{ font-size:12px; font-weight:700; color:var(--text); }
.csim-subtitle{ font-size:11px; color:var(--text-muted); }
.csim-actions{ display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.csim-flow-toggle{ display:flex; align-items:center; gap:5px; font-size:11px; color:var(--text);
  cursor:pointer; user-select:none; padding:0 4px; }
.csim-flow-toggle input{ accent-color:var(--accent); width:13px; height:13px; }
.csim-iconbtn{ display:flex; align-items:center; gap:5px; padding:4px 9px; background:var(--face);
  border-width:2px; border-style:solid; border-color:var(--face-light) var(--face-dark) var(--face-dark) var(--face-light);
  color:var(--text); font-size:11px; cursor:pointer; font-family:var(--font-ui); }
.csim-iconbtn:active{ border-color:var(--face-dark) var(--face-light) var(--face-light) var(--face-dark); }
.csim-iconbtn.run{ background:var(--accent); color:var(--accent-text);
  border-color:var(--face-light) var(--face-dark) var(--face-dark) var(--face-light); }
.csim-select{ background:#fff; border-width:2px; border-style:solid;
  border-color:var(--face-dark) var(--face-light) var(--face-light) var(--face-dark);
  padding:4px 6px; color:var(--text); font-size:11px; font-family:var(--font-ui); cursor:pointer; }
.csim-toolstrip{ display:flex; flex-direction:row; align-items:stretch; gap:3px; padding:3px 8px;
  background:var(--face); border-bottom:1px solid var(--face-dark); flex-wrap:wrap; flex-shrink:0; }
.csim-tool{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
  padding:5px 9px 4px; min-width:48px; background:var(--face);
  border-width:2px; border-style:solid; border-color:var(--face-light) var(--face-dark) var(--face-dark) var(--face-light);
  color:var(--text); cursor:pointer; }
.csim-tool span{ font-size:9px; font-family:var(--font-ui); }
.csim-tool:hover{ background:#D8D8D8; }
.csim-tool.active{ background:var(--accent); color:var(--accent-text);
  border-color:var(--face-dark) var(--face-light) var(--face-light) var(--face-dark); }
.csim-body{ display:flex; flex:1; min-height:0; }
.csim-board-wrap{ flex:1; position:relative; background:var(--canvas); overflow:hidden; min-width:0;
  border-width:2px; border-style:solid; border-color:var(--face-dark) var(--face-light) var(--face-light) var(--face-dark);
  margin:2px; }
.csim-board-svg{ width:100%; height:100%; display:block; cursor:crosshair; }
.csim-statusbar{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:3px 10px;
  background:var(--face); border-top:1px solid var(--face-dark); flex-shrink:0; font-size:10.5px;
  color:var(--text); font-family:var(--font-mono); }
.csim-statusbar-right{ display:flex; align-items:center; gap:14px; white-space:nowrap; }
.csim-inspector{ width:228px; background:var(--face); border-left:1px solid var(--face-dark); padding:10px;
  overflow-y:auto; display:flex; flex-direction:column; gap:12px; flex-shrink:0; }
.csim-panel-title{ font-size:11px; color:var(--text); font-family:var(--font-ui); font-weight:700; }
.csim-readout{ background:#fff; border-width:2px; border-style:solid;
  border-color:var(--face-dark) var(--face-light) var(--face-light) var(--face-dark); padding:8px 10px; }
.csim-readout-row{ display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; }
.csim-readout-label{ font-size:10px; color:var(--text-muted); }
.csim-readout-value{ font-size:14px; color:var(--text); font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
.csim-field{ display:flex; flex-direction:column; gap:3px; }
.csim-field label{ font-size:10px; color:var(--text); }
.csim-field input[type=number]{ background:#fff; border-width:2px; border-style:solid;
  border-color:var(--face-dark) var(--face-light) var(--face-light) var(--face-dark);
  padding:5px 7px; color:var(--text); font-family:var(--font-mono); font-size:13px; width:100%; box-sizing:border-box; }
.csim-field input[type=number]:focus{ outline:1px dotted var(--text); outline-offset:1px; }
.csim-btn{ display:flex; align-items:center; justify-content:center; gap:6px; padding:6px 12px;
  font-size:11px; cursor:pointer; background:var(--face); color:var(--text); font-family:var(--font-ui);
  border-width:2px; border-style:solid; border-color:var(--face-light) var(--face-dark) var(--face-dark) var(--face-light); }
.csim-btn:active{ border-color:var(--face-dark) var(--face-light) var(--face-light) var(--face-dark); }
.csim-btn.danger:hover{ background:var(--danger); color:#fff; }
.csim-legend-item{ display:flex; align-items:center; gap:8px; font-size:11px; color:var(--text); padding:2px 0; }
.csim-legend-swatch{ width:18px; height:3px; flex-shrink:0; }
.csim-scope-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
.csim-scope-tabs{ display:flex; gap:3px; }
.csim-scope-tab{ padding:2px 7px; font-size:9px; background:var(--face); color:var(--text); cursor:pointer;
  font-family:var(--font-mono); border-width:2px; border-style:solid;
  border-color:var(--face-light) var(--face-dark) var(--face-dark) var(--face-light); }
.csim-scope-tab.active{ background:var(--accent); color:var(--accent-text);
  border-color:var(--face-dark) var(--face-light) var(--face-light) var(--face-dark); }
.csim-scope{ position:relative; overflow:hidden; height:66px; background:#fff;
  border-width:2px; border-style:solid; border-color:var(--face-dark) var(--face-light) var(--face-light) var(--face-dark); }
.csim-scope-svg{ width:100%; height:100%; display:block; }
.csim-scope-label{ position:absolute; right:4px; font-size:9px; font-family:var(--font-mono); color:var(--text-muted);
  pointer-events:none; }
.csim-scope-label.top{ top:2px; }
.csim-scope-label.bottom{ bottom:2px; }
.csim-scope-empty{ height:66px; display:flex; align-items:center; justify-content:center; background:#fff;
  color:var(--text-dim); font-size:11px; font-family:var(--font-mono);
  border-width:2px; border-style:solid; border-color:var(--face-dark) var(--face-light) var(--face-light) var(--face-dark); }
.flow-dash{ animation-name:csimflow; animation-timing-function:linear; animation-iteration-count:infinite; }
@keyframes csimflow{ to{ stroke-dashoffset:-20; } }
`;

/* ---------------------------------------------------------------------- */
/*  Component                                                               */
/* ---------------------------------------------------------------------- */

export default function CircuitSimulator() {
  const svgRef = useRef(null);
  const idRef = useRef(EXAMPLES.led.parts.length + 1);
  const designatorCountsRef = useRef(computeDesignatorCounts(EXAMPLES.led.parts));
  const [components, setComponents] = useState(EXAMPLES.led.parts);
  const [tool, setTool] = useState("select");
  const [pendingStart, setPendingStart] = useState(null);
  const [pendingPath, setPendingPath] = useState(null); // array of {x,y} while actively drawing a multi-point wire
  const [hoverPt, setHoverPt] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [dragNodeKey, setDragNodeKey] = useState(null); // key of the node currently being dragged, if any
  const [animate, setAnimate] = useState(true);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [snapshot, setSnapshot] = useState({ voltages: {}, currents: {}, ledOn: {} });
  const [clock, setClock] = useState(0);
  const [scopeMode, setScopeMode] = useState("v");

  // Refs that back the physics loop. Kept out of React state so the
  // animation frame doesn't fight React's render cycle; `snapshot` is the
  // only thing that actually triggers a re-render, once per frame.
  const componentsRef = useRef(components);
  componentsRef.current = components;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const simStateRef = useRef({ capV: {}, indI: {} });
  const timeRef = useRef(0);
  const accumulatorRef = useRef(0);
  const lastFrameRef = useRef(null);
  const rafRef = useRef(null);
  const historyRef = useRef([]); // [{t, v, i}] for whichever part is selected, trailing HISTORY_WINDOW seconds

  const selected = components.find((c) => c.id === selectedId) || null;

  // Records one scope sample per rendered frame (not per physics substep —
  // at 5x speed a frame can contain 100+ substeps, which would flood the
  // buffer with far more resolution than the chart can show anyway).
  function recordHistory(comps, result) {
    const selId = selectedIdRef.current;
    if (!selId) return;
    const comp = comps.find((c) => c.id === selId);
    if (!comp) return;
    const pts = componentPoints(comp);
    const va = result.voltages[key(pts[0].x, pts[0].y)] ?? 0;
    const last = pts[pts.length - 1];
    const vb = pts.length > 1 ? result.voltages[key(last.x, last.y)] ?? 0 : 0;
    const t = timeRef.current;
    const arr = historyRef.current;
    arr.push({ t, v: va - vb, i: result.currents[comp.id] || 0 });
    while (arr.length > 2 && arr[0].t < t - HISTORY_WINDOW) arr.shift();
  }

  function stepPhysics(comps) {
    const result = stepTransient(comps, simStateRef.current, timeRef.current, FIXED_DT);
    simStateRef.current = result.newState;
    timeRef.current += FIXED_DT;
    return { voltages: result.voltages, currents: result.currents, ledOn: result.ledOn };
  }

  function resetSimClock() {
    simStateRef.current = { capV: {}, indI: {} };
    timeRef.current = 0;
    accumulatorRef.current = 0;
    lastFrameRef.current = null;
    historyRef.current = [];
    setClock(0);
  }

  // Any edit to the circuit takes one immediate physics step so the display
  // updates right away, whether or not the clock is currently running. Also
  // supplies the very first snapshot on mount.
  useEffect(() => {
    const result = stepPhysics(components);
    recordHistory(components, result);
    setSnapshot(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [components]);

  // Starting a fresh trace whenever the selection changes, rather than
  // showing a graph that jumps between unrelated parts' old data.
  useEffect(() => {
    historyRef.current = [];
  }, [selectedId]);

  // The continuous simulation clock. Uses componentsRef (not the `components`
  // state) so this effect only restarts on running/speed changes, not on
  // every board edit.
  useEffect(() => {
    if (!running) {
      lastFrameRef.current = null;
      return;
    }
    let alive = true;
    function tick(now) {
      if (!alive) return;
      if (lastFrameRef.current == null) lastFrameRef.current = now;
      const elapsedReal = Math.min((now - lastFrameRef.current) / 1000, 0.1);
      lastFrameRef.current = now;
      accumulatorRef.current += elapsedReal * speed;

      let stepsDone = 0;
      let lastResult = null;
      while (accumulatorRef.current >= FIXED_DT && stepsDone < MAX_STEPS_PER_FRAME) {
        lastResult = stepPhysics(componentsRef.current);
        accumulatorRef.current -= FIXED_DT;
        stepsDone++;
      }
      if (accumulatorRef.current > FIXED_DT * MAX_STEPS_PER_FRAME) accumulatorRef.current = 0;
      if (lastResult) {
        recordHistory(componentsRef.current, lastResult);
        setSnapshot(lastResult);
        setClock(timeRef.current);
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      alive = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastFrameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, speed]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") {
        setPendingStart(null);
        setPendingPath(null);
        setSelectedId(null);
        setDragNodeKey(null);
      }
      if (e.key === "Enter" && pendingPath) {
        e.preventDefault();
        commitPendingWire(pendingPath);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        removeComponent(selectedId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, pendingPath]);

  // A window-level listener (not just onMouseUp on the SVG) so a drag still
  // ends cleanly even if the mouse is released outside the board — a very
  // common way for a plain element-local handler to leave a drag "stuck".
  useEffect(() => {
    if (!dragNodeKey) return;
    const onUp = () => setDragNodeKey(null);
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [dragNodeKey]);

  function addComponent(partial) {
    const id = `c${idRef.current++}`;
    const prefix = DESIGNATOR_PREFIX[partial.type];
    const designator = prefix
      ? (() => {
          const n = (designatorCountsRef.current[partial.type] || 0) + 1;
          designatorCountsRef.current[partial.type] = n;
          return `${prefix}${n}`;
        })()
      : undefined;
    setComponents((prev) => [...prev, { ...partial, id, ...(designator ? { designator } : {}) }]);
  }
  function removeComponent(id) {
    setComponents((prev) => prev.filter((c) => c.id !== id));
    setSelectedId((s) => (s === id ? null : s));
  }
  function updateComponent(id, patch) {
    setComponents((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  function loadExample(name) {
    const ex = EXAMPLES[name];
    if (!ex) return;
    resetSimClock();
    setComponents(ex.parts.map((c) => ({ ...c })));
    idRef.current = ex.parts.length + 1;
    designatorCountsRef.current = computeDesignatorCounts(ex.parts);
    setSelectedId(null);
    setPendingStart(null);
    setPendingPath(null);
  }
  function clearBoard() {
    resetSimClock();
    setComponents([]);
    idRef.current = 1;
    designatorCountsRef.current = {};
    setSelectedId(null);
    setPendingStart(null);
    setPendingPath(null);
  }

  function handleSvgMouseMove(e) {
    const p = getSvgPoint(e, svgRef.current);
    const snapped = { x: snap(p.x, W), y: snap(p.y, H) };
    setHoverPt(snapped);
    if (dragNodeKey) moveNode(dragNodeKey, snapped.x, snapped.y);
  }

  // Moving a node means moving every endpoint (across every component, wire
  // waypoints included) that shares its exact coordinate — a node isn't
  // owned by one part, it's the shared electrical connection between
  // whatever happens to sit at that point.
  function moveNode(fromKey, toX, toY) {
    const toKey = key(toX, toY);
    if (fromKey === toKey) return;
    setComponents((prev) =>
      prev.map((c) => {
        if (c.type === "wire") {
          let changed = false;
          const newPoints = c.points.map((p) => {
            if (key(p.x, p.y) === fromKey) {
              changed = true;
              return { x: toX, y: toY };
            }
            return p;
          });
          return changed ? { ...c, points: newPoints } : c;
        }
        let changed = false;
        const patch = {};
        if (key(c.x1, c.y1) === fromKey) {
          patch.x1 = toX;
          patch.y1 = toY;
          changed = true;
        }
        if (c.type !== "ground" && key(c.x2, c.y2) === fromKey) {
          patch.x2 = toX;
          patch.y2 = toY;
          changed = true;
        }
        return changed ? { ...c, ...patch } : c;
      })
    );
    setDragNodeKey(toKey);
  }

  function handleNodeMouseDown(e, p) {
    if (tool !== "select") return;
    e.stopPropagation();
    setDragNodeKey(key(p.x, p.y));
  }

  // Commits the in-progress wire path (2+ points) as one component, or
  // silently discards it if it never got past a single point. Always clears
  // the in-progress state either way.
  function commitPendingWire(path) {
    if (path && path.length >= 2) {
      addComponent({ type: "wire", points: path });
    }
    setPendingPath(null);
  }

  function handleSvgMouseDown(e) {
    const p = getSvgPoint(e, svgRef.current);
    const snapped = { x: snap(p.x, W), y: snap(p.y, H) };

    if (tool === "ground") {
      addComponent({ type: "ground", x1: snapped.x, y1: snapped.y });
      return;
    }

    if (tool === "wire") {
      if (!pendingPath) {
        setPendingPath([snapped]);
      } else {
        const last = pendingPath[pendingPath.length - 1];
        if (snapped.x === last.x && snapped.y === last.y) {
          // clicking the current end point again finishes the wire there
          commitPendingWire(pendingPath);
        } else {
          setPendingPath([...pendingPath, snapped]);
        }
      }
      return;
    }

    if (["resistor", "capacitor", "inductor", "battery", "acsource", "led", "switch"].includes(tool)) {
      if (!pendingStart) {
        setPendingStart(snapped);
      } else {
        if (snapped.x !== pendingStart.x || snapped.y !== pendingStart.y) {
          const base = { type: tool, x1: pendingStart.x, y1: pendingStart.y, x2: snapped.x, y2: snapped.y };
          if (tool === "resistor") base.value = 1000;
          if (tool === "capacitor") base.value = 100;
          if (tool === "inductor") base.value = 100;
          if (tool === "battery") base.value = 5;
          if (tool === "acsource") {
            base.amplitude = 5;
            base.freq = 1;
          }
          if (tool === "switch") base.closed = true;
          addComponent(base);
        }
        setPendingStart(null);
      }
      return;
    }
    if (tool === "select") setSelectedId(null);
  }

  // Only intercept the click for select/delete tools. For placement tools we
  // deliberately let the mousedown bubble up to the board so a new part can
  // be started or finished exactly on top of an existing node.
  function handlePartMouseDown(e, comp) {
    if (tool === "delete") {
      e.stopPropagation();
      removeComponent(comp.id);
      return;
    }
    if (tool === "select") {
      e.stopPropagation();
      setSelectedId(comp.id);
      if (comp.type === "switch") updateComponent(comp.id, { closed: !comp.closed });
    }
  }

  const nodePoints = (() => {
    const map = new Map();
    components.forEach((c) => {
      componentPoints(c).forEach((p) => map.set(key(p.x, p.y), p));
    });
    return [...map.entries()].map(([k, p]) => ({ key: k, x: p.x, y: p.y, v: snapshot.voltages[k] ?? 0 }));
  })();

  const hopsMap = computeHops(components);

  function renderWire(c) {
    const isSelected = c.id === selectedId;
    const isHovered = c.id === hoveredId;
    const current = snapshot.currents[c.id] || 0;
    const pts = c.points;
    const p0 = pts[0];
    const pN = pts[pts.length - 1];
    const va = snapshot.voltages[key(p0.x, p0.y)] ?? 0;
    const vb = snapshot.voltages[key(pN.x, pN.y)] ?? 0;
    const col = voltageColor((va + vb) / 2);

    const showFlow = animate && Math.abs(current) > 0.00005;
    const dur = flowDuration(current);
    const dir = current >= 0 ? "normal" : "reverse";

    // Build the path, inserting a small detour wherever this wire's segments
    // were flagged as crossing something else without actually connecting.
    const HOP_R = 4.5;
    const HOP_BULGE = 6;
    let d = `M ${pts[0].x},${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const segHops = (hopsMap.get(`${c.id}:${i}`) || []).slice().sort((a, b) => a - b);
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const px = -uy;
      const py = ux;
      let cursorT = 0;
      segHops.forEach((t) => {
        const hx = p1.x + t * dx;
        const hy = p1.y + t * dy;
        const entryT = Math.max(cursorT, t - HOP_R / len);
        const exitT = Math.min(1, t + HOP_R / len);
        const ex = p1.x + entryT * dx;
        const ey = p1.y + entryT * dy;
        const xx = p1.x + exitT * dx;
        const xy = p1.y + exitT * dy;
        d += ` L ${ex},${ey} Q ${hx + px * HOP_BULGE},${hy + py * HOP_BULGE} ${xx},${xy}`;
        cursorT = exitT;
      });
      d += ` L ${p2.x},${p2.y}`;
    }

    return (
      <g key={c.id}>
        <path
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={16}
          onMouseDown={(e) => handlePartMouseDown(e, c)}
          onMouseEnter={() => setHoveredId(c.id)}
          onMouseLeave={() => setHoveredId(null)}
          style={{ cursor: tool === "select" || tool === "delete" ? "pointer" : "crosshair" }}
        />
        {(isSelected || isHovered) && (
          <path
            d={d}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={isSelected ? 11 : 8}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={isSelected ? 0.25 : 0.12}
            pointerEvents="none"
          />
        )}
        <path d={d} fill="none" stroke={col} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
        {showFlow && (
          <path
            d={d}
            fill="none"
            stroke="var(--flow)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="1 9"
            opacity={0.9}
            pointerEvents="none"
            className="flow-dash"
            style={{ animationDuration: `${dur}s`, animationDirection: dir }}
          />
        )}
        <title>{`Wire \u00B7 ${fmtV(va - vb)} \u00B7 ${fmtI(current)}`}</title>
      </g>
    );
  }

  function renderPart(c) {
    const isSelected = c.id === selectedId;
    const isHovered = c.id === hoveredId;
    const current = snapshot.currents[c.id] || 0;

    if (c.type === "wire") return renderWire(c);

    if (c.type === "ground") {
      const v = snapshot.voltages[key(c.x1, c.y1)] ?? 0;
      return (
        <g key={c.id} transform={`translate(${c.x1} ${c.y1})`}>
          <line
            x1={0}
            y1={-14}
            x2={0}
            y2={22}
            stroke="transparent"
            strokeWidth={16}
            onMouseDown={(e) => handlePartMouseDown(e, c)}
            onMouseEnter={() => setHoveredId(c.id)}
            onMouseLeave={() => setHoveredId(null)}
            style={{ cursor: tool === "select" || tool === "delete" ? "pointer" : "crosshair" }}
          />
          {(isSelected || isHovered) && (
            <circle r={isSelected ? 14 : 11} fill="var(--accent)" opacity={isSelected ? 0.22 : 0.12} />
          )}
          <line x1={0} y1={-14} x2={0} y2={4} stroke={voltageColor(v)} strokeWidth={3} pointerEvents="none" />
          <line x1={-9} y1={4} x2={9} y2={4} stroke="var(--text-muted)" strokeWidth={2.5} pointerEvents="none" />
          <line x1={-5.5} y1={9} x2={5.5} y2={9} stroke="var(--text-muted)" strokeWidth={2.5} pointerEvents="none" />
          <line x1={-2} y1={14} x2={2} y2={14} stroke="var(--text-muted)" strokeWidth={2.5} pointerEvents="none" />
          <title>{`Ground \u00B7 ${fmtV(v)}`}</title>
        </g>
      );
    }

    const dx = c.x2 - c.x1;
    const dy = c.y2 - c.y1;
    const len = Math.hypot(dx, dy) || 1;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const midx = (c.x1 + c.x2) / 2;
    const midy = (c.y1 + c.y2) / 2;
    const half = len / 2;

    const va = snapshot.voltages[key(c.x1, c.y1)] ?? 0;
    const vb = snapshot.voltages[key(c.x2, c.y2)] ?? 0;
    const colA = voltageColor(va);
    const colB = voltageColor(vb);

    const showFlow =
      animate &&
      Math.abs(current) > 0.00005 &&
      (c.type === "resistor" ||
        c.type === "battery" ||
        c.type === "acsource" ||
        c.type === "capacitor" ||
        c.type === "inductor" ||
        (c.type === "switch" && c.closed) ||
        (c.type === "led" && snapshot.ledOn[c.id]));
    const dur = flowDuration(current);
    const dir = current >= 0 ? "normal" : "reverse";

    let body = null;
    if (c.type === "resistor") {
      body = (
        <>
          <line x1={-half} y1={0} x2={-10} y2={0} stroke={colA} strokeWidth={3} pointerEvents="none" />
          <line x1={10} y1={0} x2={half} y2={0} stroke={colB} strokeWidth={3} pointerEvents="none" />
          <polyline
            points="-10,0 -6,-8 -2,8 2,-8 6,8 10,0"
            fill="none"
            stroke="var(--ink)"
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            pointerEvents="none"
          />
        </>
      );
    } else if (c.type === "capacitor") {
      body = (
        <>
          <line x1={-half} y1={0} x2={-4} y2={0} stroke={colA} strokeWidth={3} pointerEvents="none" />
          <line x1={4} y1={0} x2={half} y2={0} stroke={colB} strokeWidth={3} pointerEvents="none" />
          <line x1={-4} y1={-9} x2={-4} y2={9} stroke={colA} strokeWidth={3} pointerEvents="none" />
          <line x1={4} y1={-9} x2={4} y2={9} stroke={colB} strokeWidth={3} pointerEvents="none" />
        </>
      );
    } else if (c.type === "inductor") {
      body = (
        <>
          <line x1={-half} y1={0} x2={-14} y2={0} stroke={colA} strokeWidth={3} pointerEvents="none" />
          <line x1={14} y1={0} x2={half} y2={0} stroke={colB} strokeWidth={3} pointerEvents="none" />
          <path
            d="M -14,0 A 3.5,7 0 0 1 -7,0 A 3.5,7 0 0 1 0,0 A 3.5,7 0 0 1 7,0 A 3.5,7 0 0 1 14,0"
            fill="none"
            stroke="var(--ink)"
            strokeWidth={2.2}
            pointerEvents="none"
          />
        </>
      );
    } else if (c.type === "battery") {
      body = (
        <>
          <line x1={-half} y1={0} x2={-5} y2={0} stroke={colA} strokeWidth={3} pointerEvents="none" />
          <line x1={5} y1={0} x2={half} y2={0} stroke={colB} strokeWidth={3} pointerEvents="none" />
          <line x1={-5} y1={-6} x2={-5} y2={6} stroke="var(--ink)" strokeWidth={4.5} pointerEvents="none" strokeLinecap="round" />
          <line x1={5} y1={-11} x2={5} y2={11} stroke="var(--ink)" strokeWidth={2.5} pointerEvents="none" strokeLinecap="round" />
        </>
      );
    } else if (c.type === "acsource") {
      body = (
        <>
          <line x1={-half} y1={0} x2={-11} y2={0} stroke={colA} strokeWidth={3} pointerEvents="none" />
          <line x1={11} y1={0} x2={half} y2={0} stroke={colB} strokeWidth={3} pointerEvents="none" />
          <circle cx={0} cy={0} r={11} fill="var(--face)" stroke="var(--ink)" strokeWidth={2} pointerEvents="none" />
          <path d="M -6,0 C -4,-6 -2,-6 0,0 C 2,6 4,6 6,0" fill="none" stroke="var(--ink)" strokeWidth={1.6} pointerEvents="none" />
        </>
      );
    } else if (c.type === "led") {
      const on = snapshot.ledOn[c.id];
      const fill = on ? "#EE0000" : "var(--face)";
      body = (
        <>
          <line x1={-half} y1={0} x2={-8} y2={0} stroke={colA} strokeWidth={3} pointerEvents="none" />
          <line x1={8} y1={0} x2={half} y2={0} stroke={colB} strokeWidth={3} pointerEvents="none" />
          <polygon points="-8,-8 -8,8 8,0" fill={fill} stroke="var(--ink)" strokeWidth={1.5} pointerEvents="none" />
          <line x1={8} y1={-9} x2={8} y2={9} stroke="var(--ink)" strokeWidth={2.5} pointerEvents="none" />
          <line x1={2} y1={-12} x2={7} y2={-17} stroke={on ? "#EE0000" : "var(--text-dim)"} strokeWidth={1.5} pointerEvents="none" />
          <line x1={6} y1={-9} x2={11} y2={-14} stroke={on ? "#EE0000" : "var(--text-dim)"} strokeWidth={1.5} pointerEvents="none" />
        </>
      );
    } else if (c.type === "switch") {
      body = (
        <>
          <line x1={-half} y1={0} x2={-12} y2={0} stroke={colA} strokeWidth={3} pointerEvents="none" />
          <line x1={12} y1={0} x2={half} y2={0} stroke={colB} strokeWidth={3} pointerEvents="none" />
          <circle cx={-12} cy={0} r={2.8} fill="var(--ink)" pointerEvents="none" />
          <circle cx={12} cy={0} r={2.8} fill="var(--ink)" pointerEvents="none" />
          <line
            x1={-12}
            y1={0}
            x2={c.closed ? 12 : 9}
            y2={c.closed ? 0 : -11}
            stroke="var(--ink)"
            strokeWidth={2.5}
            strokeLinecap="round"
            pointerEvents="none"
          />
        </>
      );
    }

    const label =
      c.type === "resistor"
        ? fmtR(c.value)
        : c.type === "capacitor"
        ? fmtC(c.value)
        : c.type === "inductor"
        ? fmtL(c.value)
        : c.type === "battery"
        ? c.value + " V"
        : c.type === "acsource"
        ? c.amplitude + " Vpk @ " + fmtHz(c.freq)
        : c.type === "switch"
        ? c.closed
          ? "Closed"
          : "Open"
        : c.type === "led"
        ? snapshot.ledOn[c.id]
          ? "On"
          : "Off"
        : "";

    return (
      <g key={c.id} transform={`translate(${midx} ${midy}) rotate(${angle})`}>
        <line
          x1={-half}
          y1={0}
          x2={half}
          y2={0}
          stroke="transparent"
          strokeWidth={16}
          onMouseDown={(e) => handlePartMouseDown(e, c)}
          onMouseEnter={() => setHoveredId(c.id)}
          onMouseLeave={() => setHoveredId(null)}
          style={{ cursor: tool === "select" || tool === "delete" ? "pointer" : "crosshair" }}
        />
        {(isSelected || isHovered) && (
          <line
            x1={-half}
            y1={0}
            x2={half}
            y2={0}
            stroke="var(--accent)"
            strokeWidth={isSelected ? 11 : 8}
            strokeLinecap="round"
            opacity={isSelected ? 0.25 : 0.12}
            pointerEvents="none"
          />
        )}
        {body}
        {showFlow && (
          <line
            x1={-half}
            y1={0}
            x2={half}
            y2={0}
            stroke="var(--flow)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray="1 9"
            opacity={0.9}
            pointerEvents="none"
            className="flow-dash"
            style={{ animationDuration: `${dur}s`, animationDirection: dir }}
          />
        )}
        {c.designator && (
          <text
            x={0}
            y={-16}
            transform={`rotate(${-angle} 0 -16)`}
            textAnchor="middle"
            fontSize={9}
            fontFamily="var(--font-ui)"
            fill="var(--text-muted)"
            pointerEvents="none"
          >
            {c.designator}
          </text>
        )}
        <title>{`${c.type.charAt(0).toUpperCase()}${c.type.slice(1)}${label ? " \u00B7 " + label : ""} \u00B7 ${fmtV(
          va - vb
        )} \u00B7 ${fmtI(current)}`}</title>
      </g>
    );
  }

  function renderScope() {
    const data = historyRef.current;
    const SW = 198;
    const SH = 70;
    if (data.length < 2) {
      return <div className="csim-scope-empty">Collecting data\u2026</div>;
    }
    const tMin = data[0].t;
    const tMax = data[data.length - 1].t;
    const tSpan = Math.max(0.001, tMax - tMin);
    const key2 = scopeMode === "v" ? "v" : "i";
    let lo = Infinity;
    let hi = -Infinity;
    data.forEach((p) => {
      const val = p[key2];
      if (val < lo) lo = val;
      if (val > hi) hi = val;
    });
    const minRange = scopeMode === "v" ? 0.2 : 0.001;
    let range = hi - lo;
    if (range < minRange) {
      const mid = (hi + lo) / 2;
      lo = mid - minRange / 2;
      hi = mid + minRange / 2;
      range = minRange;
    }
    const pad = range * 0.15;
    lo -= pad;
    hi += pad;
    range = hi - lo;
    const toX = (t) => ((t - tMin) / tSpan) * SW;
    const toY = (v) => SH - ((v - lo) / range) * SH;
    const points = data.map((p) => `${toX(p.t).toFixed(1)},${toY(p[key2]).toFixed(1)}`).join(" ");
    const zeroY = lo <= 0 && hi >= 0 ? toY(0) : null;
    const fmtLabel = (v) => (scopeMode === "v" ? v.toFixed(2) + "V" : (v * 1000).toFixed(2) + "mA");

    return (
      <div className="csim-scope">
        <svg viewBox={`0 0 ${SW} ${SH}`} className="csim-scope-svg" preserveAspectRatio="none">
          {zeroY !== null && (
            <line x1={0} y1={zeroY} x2={SW} y2={zeroY} stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="3 3" />
          )}
          <polyline points={points} fill="none" stroke="var(--flow)" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <span className="csim-scope-label top">{fmtLabel(hi)}</span>
        <span className="csim-scope-label bottom">{fmtLabel(lo)}</span>
      </div>
    );
  }

  return (
    <div className="csim-shell">
      <style>{CSS}</style>

      <header className="csim-header">
        <div className="csim-brand">
          <span className="csim-mark">&#9107;</span>
          <span className="csim-title">CircuitBoard</span>
          <span className="csim-subtitle">schematic simulator</span>
        </div>
        <div className="csim-actions">
          <label className="csim-flow-toggle">
            <input type="checkbox" checked={animate} onChange={(e) => setAnimate(e.target.checked)} />
            Current flow
          </label>
          <button className={`csim-iconbtn ${running ? "run" : ""}`} onClick={() => setRunning((r) => !r)}>
            {running ? <Pause size={13} /> : <Play size={13} />}
            {running ? "Running" : "Paused"}
          </button>
          <select className="csim-select" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Simulation speed">
            {SPEED_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}x speed
              </option>
            ))}
          </select>
          <button className="csim-iconbtn" onClick={clearBoard}>
            <Eraser size={13} /> Clear
          </button>
          <select className="csim-select" defaultValue="" onChange={(e) => e.target.value && loadExample(e.target.value)} title="Load an example">
            <option value="" disabled>
              Load example…
            </option>
            {Object.entries(EXAMPLES).map(([k, ex]) => (
              <option key={k} value={k}>
                {ex.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="csim-toolstrip">
        {TOOLS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.type}
              className={`csim-tool ${tool === t.type ? "active" : ""}`}
              onClick={() => {
                if (pendingPath) commitPendingWire(pendingPath); // finish an in-progress wire rather than losing it
                setTool(t.type);
                setPendingStart(null);
              }}
              title={t.label}
            >
              <Icon size={16} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      <div className="csim-body">
        <main className="csim-board-wrap">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="csim-board-svg"
            onMouseMove={handleSvgMouseMove}
            onMouseDown={handleSvgMouseDown}
            style={dragNodeKey ? { cursor: "grabbing" } : undefined}
          >
            <rect x={0} y={0} width={W} height={H} fill="var(--canvas)" />
            <defs>
              <pattern id="csimGridMinor" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
                <path d={`M ${GRID} 0 L 0 0 0 ${GRID}`} fill="none" stroke="var(--grid-line)" strokeWidth={1} />
              </pattern>
              <pattern id="csimGridMajor" width={100} height={100} patternUnits="userSpaceOnUse">
                <path d="M 100 0 L 0 0 0 100" fill="none" stroke="var(--grid-line-major)" strokeWidth={1} />
              </pattern>
            </defs>
            <rect x={0} y={0} width={W} height={H} fill="url(#csimGridMinor)" />
            <rect x={0} y={0} width={W} height={H} fill="url(#csimGridMajor)" />
            <g className="csim-corner-marks" stroke="var(--border-strong)" strokeWidth={1.5} opacity={0.7} fill="none">
              <path d={`M 14,0 L 0,0 L 0,14`} />
              <path d={`M ${W - 14},0 L ${W},0 L ${W},14`} />
              <path d={`M 14,${H} L 0,${H} L 0,${H - 14}`} />
              <path d={`M ${W - 14},${H} L ${W},${H} L ${W},${H - 14}`} />
            </g>

            {components.map(renderPart)}

            {nodePoints.map((p) => (
              <g key={p.key}>
                {tool === "select" && (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={9}
                    fill="transparent"
                    onMouseDown={(e) => handleNodeMouseDown(e, p)}
                    style={{ cursor: dragNodeKey === p.key ? "grabbing" : "grab" }}
                  />
                )}
                {dragNodeKey === p.key && (
                  <circle cx={p.x} cy={p.y} r={9} fill="var(--accent)" opacity={0.22} pointerEvents="none" />
                )}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={dragNodeKey === p.key ? 4.5 : 3.5}
                  fill={voltageColor(p.v)}
                  stroke="var(--canvas)"
                  strokeWidth={1.5}
                  pointerEvents="none"
                />
              </g>
            ))}

            {pendingStart && hoverPt && (
              <line
                x1={pendingStart.x}
                y1={pendingStart.y}
                x2={hoverPt.x}
                y2={hoverPt.y}
                stroke="var(--accent)"
                strokeWidth={2}
                strokeDasharray="5 4"
                opacity={0.6}
                pointerEvents="none"
              />
            )}
            {pendingStart && <circle cx={pendingStart.x} cy={pendingStart.y} r={4} fill="var(--accent)" pointerEvents="none" />}

            {pendingPath && (
              <>
                <polyline
                  points={pendingPath.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={2.5}
                  strokeDasharray="5 4"
                  opacity={0.7}
                  pointerEvents="none"
                />
                {hoverPt && (
                  <line
                    x1={pendingPath[pendingPath.length - 1].x}
                    y1={pendingPath[pendingPath.length - 1].y}
                    x2={hoverPt.x}
                    y2={hoverPt.y}
                    stroke="var(--accent)"
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    opacity={0.45}
                    pointerEvents="none"
                  />
                )}
                {pendingPath.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={4} fill="var(--accent)" pointerEvents="none" />
                ))}
              </>
            )}
          </svg>
        </main>

        <aside className="csim-inspector">
          {selected ? (
            <>
              <div className="csim-panel-title">
                {selected.designator ? `${selected.designator} \u00B7 ${selected.type}` : `Selected \u00B7 ${selected.type}`}
              </div>
              <div className="csim-readout">
                <div className="csim-readout-row">
                  <span className="csim-readout-label">Voltage</span>
                  <span className="csim-readout-value">
                    {fmtV(
                      (() => {
                        const pts = componentPoints(selected);
                        const va = snapshot.voltages[key(pts[0].x, pts[0].y)] ?? 0;
                        const last = pts[pts.length - 1];
                        const vb = pts.length > 1 ? snapshot.voltages[key(last.x, last.y)] ?? 0 : 0;
                        return va - vb;
                      })()
                    )}
                  </span>
                </div>
                <div className="csim-readout-row">
                  <span className="csim-readout-label">Current</span>
                  <span className="csim-readout-value">{fmtI(snapshot.currents[selected.id] || 0)}</span>
                </div>
              </div>

              <div>
                <div className="csim-scope-head">
                  <span className="csim-panel-title">Scope · last {HISTORY_WINDOW}s</span>
                  <div className="csim-scope-tabs">
                    <button
                      className={`csim-scope-tab ${scopeMode === "v" ? "active" : ""}`}
                      onClick={() => setScopeMode("v")}
                    >
                      V
                    </button>
                    <button
                      className={`csim-scope-tab ${scopeMode === "i" ? "active" : ""}`}
                      onClick={() => setScopeMode("i")}
                    >
                      I
                    </button>
                  </div>
                </div>
                {renderScope()}
              </div>

              {selected.type === "resistor" && (
                <div className="csim-field">
                  <label>Resistance (Ω)</label>
                  <input
                    type="number"
                    min={1}
                    value={selected.value}
                    onChange={(e) => updateComponent(selected.id, { value: Math.max(1, Number(e.target.value) || 1) })}
                  />
                </div>
              )}
              {selected.type === "capacitor" && (
                <div className="csim-field">
                  <label>Capacitance (µF)</label>
                  <input
                    type="number"
                    min={0.01}
                    value={selected.value}
                    onChange={(e) => updateComponent(selected.id, { value: Math.max(0.01, Number(e.target.value) || 0.01) })}
                  />
                </div>
              )}
              {selected.type === "inductor" && (
                <div className="csim-field">
                  <label>Inductance (mH)</label>
                  <input
                    type="number"
                    min={0.01}
                    value={selected.value}
                    onChange={(e) => updateComponent(selected.id, { value: Math.max(0.01, Number(e.target.value) || 0.01) })}
                  />
                </div>
              )}
              {selected.type === "battery" && (
                <div className="csim-field">
                  <label>Voltage (V)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={selected.value}
                    onChange={(e) => updateComponent(selected.id, { value: Number(e.target.value) || 0 })}
                  />
                </div>
              )}
              {selected.type === "acsource" && (
                <>
                  <div className="csim-field">
                    <label>Amplitude (V)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={selected.amplitude}
                      onChange={(e) => updateComponent(selected.id, { amplitude: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="csim-field">
                    <label>Frequency (Hz)</label>
                    <input
                      type="number"
                      step="0.1"
                      min={0.01}
                      value={selected.freq}
                      onChange={(e) => updateComponent(selected.id, { freq: Math.max(0.01, Number(e.target.value) || 0.01) })}
                    />
                  </div>
                </>
              )}
              {selected.type === "switch" && (
                <button className="csim-btn" onClick={() => updateComponent(selected.id, { closed: !selected.closed })}>
                  {selected.closed ? "Open switch" : "Close switch"}
                </button>
              )}

              <button className="csim-btn danger" onClick={() => removeComponent(selected.id)}>
                <Trash2 size={13} /> Delete
              </button>
            </>
          ) : (
            <>
              <div className="csim-panel-title">Legend</div>
              <div>
                <div className="csim-legend-item">
                  <span className="csim-legend-swatch" style={{ background: "var(--volt-pos)" }} />
                  Positive voltage
                </div>
                <div className="csim-legend-item">
                  <span className="csim-legend-swatch" style={{ background: "var(--volt-zero)" }} />
                  Near 0 V
                </div>
                <div className="csim-legend-item">
                  <span className="csim-legend-swatch" style={{ background: "var(--volt-neg)" }} />
                  Negative voltage
                </div>
                <div className="csim-legend-item">
                  <span className="csim-legend-swatch" style={{ background: "var(--flow)" }} />
                  Current flow
                </div>
              </div>
              <div className="csim-panel-title" style={{ marginTop: 4 }}>
                Tips
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
                The board runs continuously, like a real bench — capacitors charge, inductors ramp, AC sources
                oscillate, all live. Pause anytime to freeze and inspect.
                <br />
                <br />
                Pick a part, then click two grid points to place it. Ground only needs one click. Wire is
                different: click each bend, then finish by clicking the last point again, pressing Enter, or
                switching tools. Crossing wires get a small hop where they don't actually connect.
                <br />
                <br />
                Battery/AC source: first click is −, second is +. LED: first click is the anode, second the
                cathode.
                <br />
                <br />
                Select tool: click a part to inspect or edit it; click a switch to toggle it. Delete key removes
                the selected part.
                <br />
                <br />
                If a fast RC/RL/LC circuit looks jumpy, drop the speed below 1x to watch it more smoothly.
              </div>
            </>
          )}
        </aside>
      </div>

      <div className="csim-statusbar">
        <span className="csim-statusbar-hint">
          {pendingPath
            ? "Click to add a bend; click the last point again (or press Enter) to finish \u2014 Esc to cancel."
            : pendingStart
            ? "Click the second point to finish placing \u2014 Esc to cancel."
            : tool === "select"
            ? "Click a part to inspect or edit it; drag a node to move it; click a switch to toggle it."
            : tool === "delete"
            ? "Click a part to remove it."
            : tool === "ground"
            ? "Click a grid point to place ground."
            : tool === "wire"
            ? "Click a grid point to start a wire."
            : "Click a grid point to start, then click again to finish."}
        </span>
        <span className="csim-statusbar-right">
          <span>grid {GRID}px</span>
          <span>{components.length} parts</span>
          <span>t = {clock.toFixed(2)}s</span>
        </span>
      </div>
    </div>
  );
}
