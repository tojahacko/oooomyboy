// Volumetric 3D model of "Dom w zielistkach 34 (A)", reconstructed from the
// six reference images in source/zielistki34: four elevations (front, east,
// rear, west) plus two perspective renders used to settle depth questions
// (pergola layout, entrance landing, canopy). Nothing is image-mapped: every
// wall, opening, frame, board, railing, roof slab, chimney and pergola member
// is geometry.
//
// Measurements are in elevation pixels (~76 px per metre). Plan axes:
// X runs west -> east (0..796), Z runs front -> rear (0..627); the front
// (entrance) faces south. Heights are pixels above the ground-floor level.
//
//             rear (garden)    pergola + deck over the timber-clad part
//        +---------------------------+
//   west |                           | east    gable ends, ridge along X
//        +---------------------------+
//             front (entrance)

import * as THREE from 'three';
import { box, canvasTexture, noiseFill, pipe, rng, shadow } from '../lib.js';

const PX = 1 / 76; // metres per elevation pixel
const BASE = 0.15; // ground floor level above the ground, metres

// ---------------------------------------------------------------- survey

const LEN = 796; // X, eaves-side length
const DEP = 627; // Z, gable width
const FLOOR_LINE = 228; // white ground floor / grey upper floor
const SOFFIT = 262; // boxed eave soffit
const EAVE_TOP = 281; // top of the roof at the eave edge
const RIDGE = 634; // top of the roof at the ridge
const EAVE_OUT = 69; // eave overhang (front and rear)
const RAKE_OUT = 51; // verge overhang (gable ends)
const ROOF_T = 44; // roof build-up, measured vertically
const RIDGE_Z = DEP / 2;
const TAN = (RIDGE - EAVE_TOP) / (RIDGE_Z + EAVE_OUT); // ~42.7 deg
const PITCH = Math.atan(TAN);
const CHIMNEY_TOP = 664;
const CHIMNEYS = [
  { x: [359, 427], z: [170, 236] }, // front slope, centre
  { x: [24, 90], z: [397, 459] }, // rear slope, west end
];
const ROOF_WINDOW = { x: [285, 347], z: [526, 595] }; // rear slope

const WIN_H = [69, 179]; // ground floor windows (front)
const FRENCH_H = [FLOOR_LINE, 399]; // upper floor french windows
const RAIL_H = [231, 302];

// Walls, listed left -> right as seen from outside. `at` values are plan
// coordinates along the wall, `h` heights above floor level.
const WALLS = [
  {
    name: 'front',
    p0: [0, 0], p1: [LEN, 0],
    openings: [
      { at: [72, 212], h: WIN_H, type: 'window', mullions: [142], sill: true },
      { at: [284, 364], h: [0, 165], type: 'door', glass: [315, 332], handle: 354 },
      { at: [580, 720], h: WIN_H, type: 'window', mullions: [650], sill: true },
    ],
    cladding: [{ at: [255, 500], h: [0, 179] }],
  },
  {
    name: 'east',
    p0: [LEN, 0], p1: [LEN, DEP],
    gable: true,
    openings: [
      { at: [245, 383], h: [37, 177], type: 'window', sill: true },
      { at: [142, 266], h: FRENCH_H, type: 'window', mullions: [204], railing: true },
      { at: [361, 485], h: FRENCH_H, type: 'window', mullions: [423], railing: true },
    ],
    cladding: [],
  },
  {
    name: 'rear',
    p0: [LEN, DEP], p1: [0, DEP],
    openings: [
      { at: [491, 691], h: [0, 179], type: 'slider' },
      { at: [128, 204], h: [0, 179], type: 'window' },
    ],
    cladding: [{ at: [292, LEN], h: [0, FLOOR_LINE] }],
  },
  {
    name: 'west',
    p0: [0, DEP], p1: [0, 0],
    gable: true,
    openings: [
      { at: [336, 396], h: [300, 398], type: 'window' },
      { at: [336, 396], h: [68, 177], type: 'window' },
      { at: [151, 273], h: FRENCH_H, type: 'window', mullions: [212], railing: true },
    ],
    cladding: [{ at: [336, 396], h: [177, 300] }],
  },
];

const PERGOLA = {
  x: [205, LEN],
  z: [DEP, 847],
  top: 229, // top of the beams
  post: 15, // post section, px
  midPost: 300, // extra front post under the long front beam
};
const DECK = { x: [190, 811], z: [DEP, 872] };
const LANDING = { x: [150, 505], z: [-115, 0] };
const CANOPY = { x: [255, 535], out: 78, h: 194 };

// Downspouts at the two west corners: foot on the wall, gutter outlet.
const DOWNSPOUTS = [
  { at: [24, -5], out: [24, -EAVE_OUT - 6] },
  { at: [22, DEP + 5], out: [22, DEP + EAVE_OUT + 6] },
];

// ---------------------------------------------------------------- mapping

const CX = LEN / 2;
const CZ = 340; // orbit centre sits slightly towards the pergola
const wx = (X) => (X - CX) * PX;
const wz = (Z) => (CZ - Z) * PX; // front (Z = 0) faces +z
const wy = (h) => BASE + h * PX;
const m = (v) => v * PX;
const P = (X, h, Z) => new THREE.Vector3(wx(X), wy(h), wz(Z));

// roof top surface height (px above floor) at plan depth Z
const roofTop = (Z) => RIDGE - Math.abs(Z - RIDGE_Z) * TAN;
const roofUnder = (Z) => roofTop(Z) - ROOF_T;

// ---------------------------------------------------------------- materials

function makeMaterials() {
  const plaster = (base, amount, seed) => {
    const t = canvasTexture(256, 256, (g, w, h) => noiseFill(g, w, h, base, amount, 7000, seed, 2.5), 2.5);
    t.repeat.set(1 / 2.5, 1 / 2.5);
    return t;
  };
  const tiles = canvasTexture(512, 512, (g) => {
    const row = 128, tile = 128;
    for (let r = 0; r < 4; r++) {
      const y = r * row;
      const grad = g.createLinearGradient(0, y, 0, y + row);
      grad.addColorStop(0, '#666a6f');
      grad.addColorStop(0.8, '#5a5e63');
      grad.addColorStop(1, '#4f5358');
      g.fillStyle = grad;
      g.fillRect(0, y, 512, row);
      g.fillStyle = 'rgba(12,14,17,0.65)';
      g.fillRect(0, y, 512, 9);
      g.fillStyle = 'rgba(12,14,17,0.25)';
      g.fillRect(0, y + 9, 512, 8);
      const off = (r % 2) * (tile / 2);
      g.fillStyle = 'rgba(25,28,32,0.6)';
      for (let x = -tile; x < 512 + tile; x += tile) g.fillRect(x + off, y, 3, row);
    }
  }, 1);
  const tileBump = canvasTexture(512, 512, (g) => {
    for (let r = 0; r < 4; r++) {
      const y = r * 128;
      const grad = g.createLinearGradient(0, y, 0, y + 128);
      grad.addColorStop(0, '#1a1a1a');
      grad.addColorStop(0.12, '#ffffff');
      grad.addColorStop(1, '#b8b8b8');
      g.fillStyle = grad;
      g.fillRect(0, y, 512, 128);
      g.fillStyle = '#6a6a6a';
      for (let x = -128; x < 640; x += 128) g.fillRect(x + (r % 2) * 64, y, 3, 128);
    }
  }, 1);
  tileBump.colorSpace = THREE.NoColorSpace;
  const woodGrain = canvasTexture(64, 512, (g, w, h) => {
    g.fillStyle = '#d3ad80';
    g.fillRect(0, 0, w, h);
    g.filter = 'blur(2px)';
    const r = rng(23);
    for (let i = 0; i < 14; i++) {
      g.fillStyle = r() > 0.5 ? `rgba(120,75,35,${0.06 + r() * 0.09})` : `rgba(255,232,195,${0.05 + r() * 0.08})`;
      g.fillRect(r() * w, 0, 3 + r() * 6, h);
    }
    g.filter = 'none';
  }, 1);
  const deckBoards = canvasTexture(512, 256, (g, w, h) => {
    g.fillStyle = '#bd9670';
    g.fillRect(0, 0, w, h);
    const r = rng(9);
    for (let b = 0; b < 8; b++) {
      const y = (b * h) / 8;
      g.fillStyle = `rgba(${r() > 0.5 ? '255,235,200' : '70,40,15'},${0.05 + r() * 0.07})`;
      g.fillRect(0, y, w, h / 8);
      g.fillStyle = 'rgba(45,28,12,0.65)';
      g.fillRect(0, y, w, 2);
    }
  }, 1);
  deckBoards.repeat.set(1 / 1.2, 1 / 1.2);

  const std = (o) => new THREE.MeshStandardMaterial(o);
  const M = {
    tileSize: [0.33 * 4, 0.33 * 4],
    white: std({ map: plaster('#f0f0ec', 0.05, 1), roughness: 0.92 }),
    grey: std({ map: plaster('#a2a4a6', 0.1, 2), roughness: 0.92 }),
    plinth: std({ map: plaster('#b2b2ad', 0.2, 3), roughness: 1 }),
    concrete: std({ map: plaster('#c3c3be', 0.18, 4), roughness: 1 }),
    chimney: std({ map: plaster('#595c60', 0.1, 5), roughness: 0.9 }),
    chimneyCap: std({ color: '#66696d', roughness: 0.7, metalness: 0.2 }),
    tiles: std({ map: tiles, bumpMap: tileBump, bumpScale: 3, roughness: 0.8 }),
    verge: std({ color: '#44474b', roughness: 0.7, metalness: 0.2, side: THREE.DoubleSide }),
    soffit: std({ color: '#5d6064', roughness: 0.85, side: THREE.DoubleSide }),
    dark: std({ color: '#3d4044', roughness: 0.5, metalness: 0.4 }),
    gutter: std({ color: '#3d4044', roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide }),
    frame: std({ color: '#37393d', roughness: 0.45, metalness: 0.35 }),
    door: std({ color: '#3a3d41', roughness: 0.5, metalness: 0.3 }),
    steel: std({ color: '#c9ccd0', roughness: 0.25, metalness: 1 }),
    glass: std({ color: '#8ea3b1', roughness: 0.04, metalness: 0.95, transparent: true, opacity: 0.5 }),
    clearGlass: std({
      color: '#dcefe9', roughness: 0.05, metalness: 0.4, transparent: true, opacity: 0.3, depthWrite: false,
    }),
    interior: std({ color: '#2b2f33', roughness: 1 }),
    blind: std({ color: '#e4e5e4', roughness: 0.9 }),
    wood: std({ map: woodGrain, roughness: 0.75 }),
    woodBacking: std({ color: '#3a2b1f', roughness: 0.9 }),
    timber: std({ map: woodGrain, color: '#f2e2cc', roughness: 0.7 }),
    deck: std({ map: deckBoards, roughness: 0.85 }),
  };
  M.glass.userData.reflect = true;
  M.clearGlass.userData.reflect = true;
  for (const [key, mat] of Object.entries(M)) if (mat.isMaterial) mat.name = key; // kept by glTF export
  return M;
}

// ---------------------------------------------------------------- walls

// Group whose local +x runs along the wall (p0 -> p1), +z points outward,
// y is up with 0 at floor level, origin at p0 on the outer face.
function wallFrame(p0, p1) {
  const a = P(p0[0], 0, p0[1]);
  const b = P(p1[0], 0, p1[1]);
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  const normal = new THREE.Vector3(-dir.z, 0, dir.x);
  const g = new THREE.Group();
  g.position.copy(a);
  g.position.y = BASE;
  g.rotation.y = Math.atan2(normal.x, normal.z);
  const axis = p0[0] === p1[0] ? 1 : 0;
  const sign = Math.sign(p1[axis] - p0[axis]);
  const along = (c) => (c - p0[axis]) * sign * PX; // plan coordinate -> metres
  const planAt = (u) => p0[axis] + (u / PX) * sign; // and back
  return { group: g, length: a.distanceTo(b), along, planAt };
}

// Extruded wall piece: polygon (metres, local u/v) pushed WALL_T inward.
const WALL_T = 0.35;
function wallPiece(points, material) {
  const shape = new THREE.Shape(points.map(([u, v]) => new THREE.Vector2(u, v)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: WALL_T, bevelEnabled: false });
  geo.translate(0, 0, -WALL_T);
  return shadow(new THREE.Mesh(geo, material));
}

// Subtract openings from [lo, hi] vertical ranges.
function subtract(ranges, holes) {
  let out = ranges;
  for (const [h0, h1] of holes) {
    out = out.flatMap(([a, b]) => {
      const r = [];
      if (h0 > a) r.push([a, Math.min(h0, b)]);
      if (h1 < b) r.push([Math.max(h1, a), b]);
      return r.filter(([p, q]) => q - p > 1e-5);
    });
  }
  return out;
}

function buildWall(spec, M) {
  const { group, length, along, planAt } = wallFrame(spec.p0, spec.p1);
  const span = (a, b) => [Math.min(along(a), along(b)), Math.max(along(a), along(b))];
  const openings = spec.openings.map((o) => ({ ...o, r: span(...o.at), v: [m(o.h[0]), m(o.h[1])] }));
  // wall top (metres above floor) at a distance u along this wall
  const top = (u) => m(spec.gable ? roofUnder(planAt(u)) : SOFFIT);

  const cuts = new Set([0, length]);
  openings.forEach((o) => o.r.forEach((x) => cuts.add(x)));
  if (spec.gable) cuts.add(length / 2);
  const xs = [...cuts].sort((a, b) => a - b);
  const eps = 0.003;
  const line = m(FLOOR_LINE);

  for (let i = 0; i < xs.length - 1; i++) {
    let a = xs[i];
    let b = xs[i + 1];
    if (b - a < 1e-5) continue;
    const mid = (a + b) / 2;
    const holes = openings.filter((o) => o.r[0] <= mid && mid < o.r[1]).map((o) => o.v);
    const ranges = subtract([[0, Infinity]], holes);
    if (a === 0) a += eps;
    if (b === length) b -= eps;
    for (const [v0, v1] of ranges) {
      // split at the floor line: white below, grey above
      const parts = v0 < line && v1 > line ? [[v0, line], [line, v1]] : [[v0, v1]];
      for (const [p0, p1] of parts) {
        const mat = p1 <= line + 1e-6 ? M.white : M.grey;
        const pts = p1 === Infinity
          ? [[a, p0], [b, p0], [b, top(b)], [a, top(a)]]
          : [[a, p0], [b, p0], [b, p1], [a, p1]];
        group.add(wallPiece(pts, mat));
      }
    }
  }

  // floor-line flashing and plinth, continuous around the corners
  group.add(box(-0.02, length + 0.02, line - 0.015, line + 0.015, -WALL_T, 0.02, M.dark));
  group.add(box(-0.03, length + 0.03, -BASE, 0, -WALL_T, 0.03, M.plinth));

  for (const c of spec.cladding) buildCladding(group, span(...c.at), [m(c.h[0]), m(c.h[1])], openings, M);
  for (const o of openings) buildOpening(group, o, along, M);
  return group;
}

// Vertical timber boards over a dark backing, cut around openings.
function buildCladding(group, [u0, u1], [v0, v1], openings, M) {
  const cuts = new Set([u0, u1]);
  openings.forEach((o) => o.r.forEach((x) => x > u0 && x < u1 && cuts.add(x)));
  const xs = [...cuts].sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const mid = (xs[i] + xs[i + 1]) / 2;
    const holes = openings.filter((o) => o.r[0] <= mid && mid < o.r[1]).map((o) => o.v);
    for (const [p, q] of subtract([[v0, v1]], holes)) pieces.push([xs[i], xs[i + 1], p, q]);
  }
  const pitch = 0.1;
  const w = 0.091;
  const d = 0.028;
  const items = [];
  for (const [a, b, p, q] of pieces) {
    group.add(box(a, b, p, q, 0, 0.004, M.woodBacking));
    const n = Math.max(1, Math.round((b - a) / pitch));
    const step = (b - a) / n;
    for (let k = 0; k < n; k++) items.push([a + step * (k + 0.5), p, q, step]);
  }
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), M.wood, items.length);
  const mat4 = new THREE.Matrix4();
  const col = new THREE.Color();
  const r = rng(items.length * 17 + 3);
  items.forEach(([x, p, q, step], i) => {
    mat4.compose(new THREE.Vector3(x, (p + q) / 2, d / 2), new THREE.Quaternion(), new THREE.Vector3(step * (w / pitch), q - p, d));
    mesh.setMatrixAt(i, mat4);
    const k = 0.88 + r() * 0.22;
    col.setRGB(k, k * (0.97 + r() * 0.04), k * (0.93 + r() * 0.07));
    mesh.setColorAt(i, col);
  });
  group.add(shadow(mesh));
}

// Window / door infill recessed into the reveal.
function buildOpening(group, o, along, M) {
  const [u0, u1] = o.r;
  const [v0, v1] = o.v;
  const inset = 0.1;
  const f = 0.07;
  const fd = 0.08;
  const zf = -inset;

  // dark room behind the glazing, and the frame
  group.add(box(u0, u1, v0, v1, -WALL_T + 0.01, -WALL_T + 0.03, M.interior));
  const frame = () => {
    group.add(box(u0, u0 + f, v0, v1, zf - fd, zf, M.frame));
    group.add(box(u1 - f, u1, v0, v1, zf - fd, zf, M.frame));
    group.add(box(u0, u1, v1 - f, v1, zf - fd, zf, M.frame));
    group.add(box(u0, u1, v0, v0 + f, zf - fd, zf, M.frame));
  };

  if (o.type === 'door') {
    frame();
    group.add(box(u0 + f, u1 - f, v0 + f * 0.3, v1 - f, zf - fd, zf - 0.03, M.door));
    const [g0, g1] = [along(o.glass[0]), along(o.glass[1])].sort((a, b) => a - b);
    group.add(box(g0, g1, v0 + 0.15, v1 - 0.18, zf - 0.034, zf - 0.024, M.glass));
    const hx = along(o.handle);
    const hy0 = v0 + 0.5, hy1 = v0 + 1.7;
    group.add(pipe(new THREE.Vector3(hx, hy0, zf + 0.05), new THREE.Vector3(hx, hy1, zf + 0.05), 0.014, M.steel));
    for (const hy of [hy0 + 0.05, hy1 - 0.05]) group.add(box(hx - 0.01, hx + 0.01, hy - 0.01, hy + 0.01, zf - 0.03, zf + 0.05, M.steel));
    return;
  }

  // blinds rolled half down behind the glass, as in the references
  const blindTop = v1 - f;
  const blindBot = v1 - f - (v1 - v0) * (o.type === 'slider' ? 0.12 : 0.3);
  group.add(box(u0 + f, u1 - f, blindBot, blindTop, zf - fd - 0.06, zf - fd - 0.05, M.blind));

  if (o.type === 'slider') {
    frame();
    const mid = (u0 + u1) / 2;
    // two sashes, one sliding in front of the other
    for (const [a, b, z] of [[u0 + f, mid + 0.03, zf - fd], [mid - 0.03, u1 - f, zf - fd + 0.035]]) {
      group.add(box(a, a + 0.05, v0 + f, v1 - f, z, z + 0.04, M.frame));
      group.add(box(b - 0.05, b, v0 + f, v1 - f, z, z + 0.04, M.frame));
      group.add(box(a, b, v1 - f - 0.05, v1 - f, z, z + 0.04, M.frame));
      group.add(box(a, b, v0 + f, v0 + f + 0.05, z, z + 0.04, M.frame));
      group.add(box(a + 0.05, b - 0.05, v0 + f + 0.05, v1 - f - 0.05, z + 0.015, z + 0.02, M.glass));
    }
    return;
  }

  frame();
  group.add(box(u0 + f, u1 - f, v0 + f, v1 - f, zf - fd + 0.02, zf - fd + 0.03, M.glass));
  for (const mu of o.mullions || []) {
    const x = along(mu);
    group.add(box(x - f / 2, x + f / 2, v0, v1, zf - fd, zf, M.frame));
  }
  if (o.sill) group.add(box(u0 - 0.03, u1 + 0.03, v0 - 0.035, v0, zf, 0.06, M.frame));
  if (o.railing) {
    // frameless glass balustrade fixed to the face of the wall
    const a = u0 - m(8), b = u1 + m(8);
    const r0 = m(RAIL_H[0]), r1 = m(RAIL_H[1]);
    const glass = box(a, b, r0, r1, 0.05, 0.062, M.clearGlass);
    glass.castShadow = false;
    group.add(glass);
    for (const x of [a + 0.06, b - 0.06]) {
      for (const y of [r0 + 0.08, r1 - 0.08]) group.add(box(x - 0.025, x + 0.025, y - 0.025, y + 0.025, 0, 0.07, M.steel));
    }
    group.add(box(a, b, r0 - 0.02, r0, 0.03, 0.075, M.steel));
  }
}

// ---------------------------------------------------------------- roof

// Closed prism from a top quad (world points) pushed down by `offset`.
// Material groups: 0 top (tiles), 1 underside, 2 edges.
function slab(top, offset, eave, upslope) {
  const bot = top.map((p) => p.clone().add(offset));
  const pos = [];
  const uv = [];
  const groups = [];
  const eaveH = Math.min(...top.map((p) => p.y));
  const quad = (q, g) => {
    const start = pos.length / 3;
    for (const idx of [0, 1, 2, 0, 2, 3]) {
      const p = q[idx];
      pos.push(p.x, p.y, p.z);
      uv.push(p.dot(eave), p.clone().sub(new THREE.Vector3(0, eaveH, 0)).dot(upslope));
    }
    groups.push([start, 6, g]);
  };
  quad(top, 0);
  quad([bot[3], bot[2], bot[1], bot[0]], 1);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad([top[j], top[i], bot[i], bot[j]], 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  groups.forEach(([s, c, g]) => geo.addGroup(s, c, g));
  geo.computeVertexNormals();
  return geo;
}

function buildRoof(M) {
  const g = new THREE.Group();
  const x0 = -RAKE_OUT;
  const x1 = LEN + RAKE_OUT;
  const [su, sv] = M.tileSize;
  const tileMat = M.tiles.clone();
  tileMat.map = M.tiles.map.clone();
  tileMat.bumpMap = M.tiles.bumpMap.clone();
  for (const t of [tileMat.map, tileMat.bumpMap]) {
    t.repeat.set(1 / su, 1 / sv);
    t.needsUpdate = true;
  }
  const mats = [tileMat, M.soffit, M.verge];

  const tPerp = m(ROOF_T) * Math.cos(PITCH);
  for (const side of [-1, 1]) {
    // side -1: front slope (eave at Z = -EAVE_OUT), +1: rear slope
    const eZ = side < 0 ? -EAVE_OUT : DEP + EAVE_OUT;
    const top = [P(x0, EAVE_TOP, eZ), P(x1, EAVE_TOP, eZ), P(x1, RIDGE, RIDGE_Z), P(x0, RIDGE, RIDGE_Z)];
    if (side > 0) top.reverse();
    const up = new THREE.Vector3().subVectors(P(0, RIDGE, RIDGE_Z), P(0, EAVE_TOP, eZ)).normalize();
    const normal = new THREE.Vector3(1, 0, 0).cross(up).normalize();
    if (normal.y < 0) normal.negate();
    const mesh = new THREE.Mesh(slab(top, normal.clone().multiplyScalar(-tPerp), new THREE.Vector3(1, 0, 0), up), mats);
    g.add(shadow(mesh));

    // boxed eave: soffit, fascia, gutter and end caps
    const fo = side < 0 ? 1 : -1; // outward direction in world z
    const zOut = wz(eZ);
    const zWall = wz(side < 0 ? 0 : DEP);
    const span = (a, b) => [Math.min(a, b), Math.max(a, b)];
    g.add(box(wx(x0), wx(x1), wy(SOFFIT) - 0.02, wy(SOFFIT), ...span(zOut, zWall), M.soffit));
    g.add(box(wx(x0), wx(x1), wy(SOFFIT) - 0.03, wy(EAVE_TOP) + 0.01, ...span(zOut, zOut + fo * 0.04), M.verge));
    const gut = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, m(x1 - x0) + 0.04, 16, 1, false, Math.PI, Math.PI), M.gutter);
    gut.rotation.z = Math.PI / 2;
    gut.position.set(0, wy(EAVE_TOP) - 0.1, zOut + fo * 0.1);
    g.add(shadow(gut));
    // the roof underside crosses the soffit level just inside the fascia;
    // close the triangle between them at both gable ends
    const zCross = wz(side < 0 ? RIDGE_Z - (RIDGE - SOFFIT - ROOF_T) / TAN : RIDGE_Z + (RIDGE - SOFFIT - ROOF_T) / TAN);
    const tri = new THREE.Shape([
      new THREE.Vector2(zCross, wy(SOFFIT)),
      new THREE.Vector2(zWall, wy(SOFFIT)),
      new THREE.Vector2(zWall, wy(roofUnder(side < 0 ? 0 : DEP))),
    ]);
    for (const X of [x0, x1]) {
      const cap = new THREE.Mesh(new THREE.ShapeGeometry(tri), M.soffit);
      cap.rotation.y = -Math.PI / 2; // shape x -> world z, shape y -> world y
      cap.position.x = wx(X) + (X === x0 ? -0.002 : 0.002);
      g.add(shadow(cap));
    }
  }

  // ridge cap
  const ridge = box(wx(x0) - 0.02, wx(x1) + 0.02, -0.11, 0.11, -0.11, 0.11, M.verge);
  ridge.rotation.x = Math.PI / 4;
  ridge.position.set(wx(LEN / 2), wy(RIDGE) - 0.04, wz(RIDGE_Z));
  g.add(ridge);

  // purlin and wall-plate ends under the verges
  for (const X of [x0, LEN]) {
    for (const Z of [45, 170, DEP - 170, DEP - 45]) {
      const hTop = roofUnder(Z) - 2;
      g.add(box(wx(X), wx(X + RAKE_OUT), wy(hTop - 16), wy(hTop), wz(Z) - 0.07, wz(Z) + 0.07, M.verge));
    }
  }

  // chimneys
  for (const c of CHIMNEYS) {
    const y0 = wy(roofTop(c.z[0] < RIDGE_Z ? c.z[0] : c.z[1]) - 60);
    const y1 = wy(CHIMNEY_TOP);
    g.add(box(wx(c.x[0]), wx(c.x[1]), y0, y1, wz(c.z[1]), wz(c.z[0]), M.chimney));
    g.add(box(wx(c.x[0]) - 0.04, wx(c.x[1]) + 0.04, y1, y1 + 0.07, wz(c.z[1]) - 0.04, wz(c.z[0]) + 0.04, M.chimneyCap));
  }

  // roof window on the rear slope
  const rw = ROOF_WINDOW;
  const zc = (rw.z[0] + rw.z[1]) / 2;
  const slopeLen = m(rw.z[1] - rw.z[0]) / Math.cos(PITCH);
  const win = new THREE.Group();
  win.position.copy(P((rw.x[0] + rw.x[1]) / 2, roofTop(zc), zc));
  win.rotation.x = -PITCH; // local y = rear slope normal, local z = up-slope
  const w = m(rw.x[1] - rw.x[0]);
  win.add(box(-w / 2, w / 2, -0.02, 0.1, -slopeLen / 2, slopeLen / 2, M.frame));
  const glass = box(-w / 2 + 0.07, w / 2 - 0.07, 0.1, 0.108, -slopeLen / 2 + 0.07, slopeLen / 2 - 0.07, M.glass);
  win.add(glass);
  g.add(win);
  return g;
}

// ---------------------------------------------------------------- outdoor

function buildPergola(M) {
  const g = new THREE.Group();
  const p = PERGOLA;
  const s = p.post;
  const top = p.top;
  const beam = 17;
  const X0 = p.x[0], X1 = p.x[1], Z0 = p.z[0], Z1 = p.z[1];
  const post = (xa, za) => g.add(box(wx(xa), wx(xa + s), 0, wy(top - beam), wz(za + s), wz(za), M.timber));
  for (const X of [X0, X1 - s]) {
    post(X, Z0 + 5);
    post(X, Z1 - s);
  }
  post(p.midPost - s / 2, Z1 - s);
  // perimeter beams and wall ledger
  g.add(box(wx(X0), wx(X1), wy(top - beam), wy(top), wz(Z1), wz(Z1 - 12), M.timber));
  g.add(box(wx(X0), wx(X1), wy(top - beam), wy(top), wz(Z0 + 10), wz(Z0), M.timber));
  for (const X of [X0, X1 - 12]) g.add(box(wx(X), wx(X + 12), wy(top - beam), wy(top), wz(Z1), wz(Z0), M.timber));
  // rafters
  const n = 14;
  for (let k = 1; k < n; k++) {
    const X = X0 + ((X1 - X0) * k) / n;
    g.add(box(wx(X) - 0.03, wx(X) + 0.03, wy(top - 12), wy(top), wz(Z1 - 12), wz(Z0 + 10), M.timber));
  }
  // raised deck with a step
  const d = DECK;
  const deck = box(wx(d.x[0]), wx(d.x[1]), 0, BASE, wz(d.z[1]), wz(d.z[0]), M.deck);
  g.add(deck);
  g.add(box(wx(d.x[0]) + 0.1, wx(d.x[1]) - 0.1, 0, BASE / 2, wz(d.z[1] + 26), wz(d.z[1]), M.deck));
  return g;
}

function buildEntrance(M) {
  const g = new THREE.Group();
  const L = LANDING;
  g.add(box(wx(L.x[0]), wx(L.x[1]), 0, BASE, wz(0), wz(L.z[0]), M.concrete));
  g.add(box(wx(L.x[0]) + 0.1, wx(L.x[1]) - 0.1, 0, BASE / 2, wz(L.z[0]), wz(L.z[0] - 26), M.concrete));

  // glass canopy on steel arms with tension rods
  const C = CANOPY;
  const zWall = wz(0);
  const zOut = wz(-C.out);
  const y = wy(C.h);
  const glass = box(wx(C.x[0]), wx(C.x[1]), y, y + 0.02, zWall, zOut, M.clearGlass);
  glass.castShadow = false;
  g.add(glass);
  for (let k = 0; k < 5; k++) {
    const X = C.x[0] + 8 + ((C.x[1] - C.x[0] - 16) * k) / 4;
    g.add(box(wx(X) - 0.01, wx(X) + 0.01, y - 0.05, y, zWall, zOut - 0.01, M.steel));
    g.add(pipe(new THREE.Vector3(wx(X), y - 0.02, zOut - 0.05), new THREE.Vector3(wx(X), y + 0.45, zWall + 0.04), 0.008, M.steel));
  }

  // house number "V" and intercom on the timber panel
  const zs = zWall + 0.035;
  g.add(box(wx(452), wx(478), wy(156), wy(158), zs, zs + 0.015, M.steel));
  g.add(pipe(new THREE.Vector3(wx(455), wy(150), zs + 0.01), new THREE.Vector3(wx(465), wy(128), zs + 0.01), 0.012, M.steel));
  g.add(pipe(new THREE.Vector3(wx(475), wy(150), zs + 0.01), new THREE.Vector3(wx(465), wy(128), zs + 0.01), 0.012, M.steel));
  g.add(box(wx(380), wx(388), wy(104), wy(118), zs, zs + 0.02, M.steel));

  // wall lights on the garden side
  for (const [a, b] of [[717, 748], [429, 465]]) {
    g.add(box(wx(a), wx(b), wy(174), wy(178), wz(DEP) - 0.1, wz(DEP) - 0.03, M.steel));
  }

  // downspouts: gutter outlet -> under the soffit -> back to the wall -> down
  for (const d of DOWNSPOUTS) {
    const r = 0.045;
    const outlet = P(d.out[0], EAVE_TOP - 12, d.out[1]);
    const drop = P(d.out[0], SOFFIT - 8, d.out[1]);
    const knee = P(d.at[0], SOFFIT - 28, d.at[1]);
    const foot = P(d.at[0], 0, d.at[1]);
    foot.y = 0;
    g.add(pipe(outlet, drop, r, M.dark));
    g.add(pipe(drop, knee, r, M.dark));
    g.add(pipe(knee, foot, r, M.dark));
    for (const h of [40, 140, 220]) {
      const c = P(d.at[0], h, d.at[1]);
      g.add(pipe(c.clone().setY(c.y - 0.03), c.clone().setY(c.y + 0.03), r * 1.3, M.dark));
    }
  }
  return g;
}

// ---------------------------------------------------------------- house

export function buildHouse() {
  const M = makeMaterials();
  const house = new THREE.Group();
  for (const spec of WALLS) house.add(buildWall(spec, M));
  house.add(buildRoof(M));
  house.add(buildPergola(M));
  house.add(buildEntrance(M));
  return { house, materials: M };
}

// turntable framing for this house
export const ORBIT = { radius: 27, height: 8.2, fov: 30, target: [0, 3.9, 0] };
