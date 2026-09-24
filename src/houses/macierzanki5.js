// Volumetric 3D model of "Dom w macierzankach 5 (G2)", reconstructed from its
// four elevation drawings (source/elevation_*.png). No image is mapped onto
// the model: every wall, opening, reveal, frame, cladding slat, roof plane,
// chimney, gutter and downspout is real geometry.
//
// Measurements are in elevation pixels (~55 px per metre) and converted to
// metres here. Plan axes: X runs west -> east, Z runs north -> south (the
// front / garage side is south). Heights are pixels above ground.
//
//            north (garden, terrace)
//   +-----------+.......
//   |           |  deck :
//   |           +---------+
//   |   wing    |  main   |   east
//   |  (garage) |  body   |
//   |           +---------+
//   |        +--+
//   |        |porch
//   +--------+--+
//            south (front, entrance)

import * as THREE from 'three';
import { bar, box, canvasTexture, noiseFill, pipe, rng, shadow, worldUV } from '../lib.js';

const PX = 1 / 55; // metres per elevation pixel

// ---------------------------------------------------------------- survey

const WING = { x0: 0, x1: 490, z0: 0, z1: 1058 };
const MAIN = { x0: 490, x1: 874, z0: 277, z1: 770 };
const PORCH = { x0: 374, x1: 490, z0: 872, z1: 1058 }; // recessed entrance
const PILLAR = { x0: 466, x1: 490, z0: 1004, z1: 1058 };
const DECK = { x0: 66, x1: 849, z0: -105, z1: 277 };

const H = {
  plinth: 8, // plinth band on top of the ground
  low: 135, // top of the lower wall / underside of the white trim
  trim: 143, // top of the white trim band
  wall: 188, // soffit
};
const WALL_T = 0.35; // wall thickness, metres
const FASCIA = 14;
const OVERHANG = 46;
const PITCH = Math.atan(0.584); // ~30 deg
const CHIMNEY_TOP = 394;
const CHIMNEYS = [
  [207, 253, 638, 689],
  [289, 332, 337, 380],
  [494, 559, 571, 610],
];

// Full-height glazing reaches the trim; ~0.2 m sill above the floor.
const FULL = [10, 133];

// Lower walls. p0 -> p1 runs left to right as seen from outside. Spans and
// openings are given in plan coordinates along the wall.
//   span: [from, to, material]
//   opening: { at: [from, to], h: [bottom, top], type, mullions, sill, ... }
const LOWER_WALLS = [
  {
    name: 'wing front',
    p0: [0, 1058], p1: [374, 1058],
    spans: [[0, 374, 'grey']],
    openings: [{ at: [52, 319], h: [9, 132], type: 'garage' }],
  },
  {
    name: 'porch back',
    p0: [374, 872], p1: [490, 872],
    spans: [[374, 490, 'wood']],
    openings: [
      { at: [377, 404], h: [9, 121], type: 'window' },
      { at: [404, 458], h: [9, 121], type: 'door', glass: [418, 431], handle: 413 },
    ],
  },
  {
    name: 'porch side',
    p0: [374, 1058], p1: [374, 872],
    spans: [[872, 1058, 'wood']],
    openings: [],
  },
  {
    name: 'wing east south',
    p0: [490, 872], p1: [490, 770],
    spans: [[770, 872, 'wood']],
    openings: [{ at: [827, 867], h: [13, 128], type: 'window' }],
  },
  {
    name: 'main front',
    p0: [490, 770], p1: [874, 770],
    spans: [[490, 628, 'wood'], [628, 874, 'grey']],
    openings: [{ at: [716, 870], h: [61, 133], type: 'window', mullions: [765], sill: [712, 880] }],
  },
  {
    name: 'main east',
    p0: [874, 770], p1: [874, 277],
    spans: [[277, 337, 'wood'], [337, 770, 'grey']],
    openings: [
      { at: [679, 764], h: [61, 133], type: 'window', sill: [674, 774] },
      { at: [337, 497], h: FULL, type: 'window', mullions: [417] },
    ],
  },
  {
    name: 'main rear',
    p0: [874, 277], p1: [490, 277],
    spans: [[829, 874, 'white'], [667, 829, 'white'], [490, 667, 'wood']],
    openings: [
      { at: [667, 829], h: [9, 133], type: 'window', mullions: [744] },
      { at: [519, 577], h: [13, 131], type: 'window' },
    ],
  },
  {
    name: 'wing east north',
    p0: [490, 277], p1: [490, 0],
    spans: [[0, 27, 'white'], [27, 277, 'wood']],
    openings: [{ at: [230, 267], h: [59, 130], type: 'window' }],
  },
  {
    name: 'wing rear',
    p0: [490, 0], p1: [0, 0],
    spans: [[407, 490, 'wood'], [206, 407, 'grey'], [109, 206, 'grey'], [0, 109, 'white']],
    openings: [
      { at: [311, 407], h: [13, 131], type: 'window', mullions: [359] },
      { at: [109, 206], h: [9, 133], type: 'window', mullions: [157] },
    ],
  },
  {
    name: 'wing west',
    p0: [0, 0], p1: [0, 1058],
    spans: [[0, 264, 'white'], [264, 384, 'grey'], [384, 483, 'grey'], [483, 574, 'white'], [574, 1058, 'grey']],
    openings: [
      { at: [264, 312], h: [12, 133], type: 'window' },
      { at: [384, 483], h: FULL, type: 'window', mullions: [432] },
      { at: [601, 656], h: [9, 126], type: 'door', glass: [616, 626], handle: 607 },
    ],
  },
];

// Outer perimeter carrying the white upper band + trim (spans the porch).
const UPPER_WALLS = [
  [[0, 1058], [490, 1058]],
  [[490, 1058], [490, 770]],
  [[490, 770], [874, 770]],
  [[874, 770], [874, 277]],
  [[874, 277], [490, 277]],
  [[490, 277], [490, 0]],
  [[490, 0], [0, 0]],
  [[0, 0], [0, 1058]],
];

// Downspouts: foot position on the wall and the gutter point they rise to.
const GUTTER_OUT = OVERHANG + 5.5; // gutter centre line, px outside the wall
const DOWNSPOUTS = [
  { at: [-4, 1040], to: [-GUTTER_OUT, 1040] },
  { at: [-4, 16], to: [-GUTTER_OUT, 16] },
  { at: [474, -4], to: [474, -GUTTER_OUT] },
  { at: [878, 288], to: [874 + GUTTER_OUT, 288] },
  { at: [878, 762], to: [874 + GUTTER_OUT, 762] },
  { at: [497, 775], to: [541, 821] },
];

// ---------------------------------------------------------------- helpers

const CX = (WING.x0 - OVERHANG + MAIN.x1 + OVERHANG) / 2;
const CZ = (WING.z0 - OVERHANG + WING.z1 + OVERHANG) / 2;
const wx = (X) => (X - CX) * PX;
const wz = (Z) => (Z - CZ) * PX;
const m = (v) => v * PX;
const P = (X, Y, Z) => new THREE.Vector3(wx(X), m(Y), wz(Z));

// Group whose local +x runs along the wall (p0 -> p1), +z points outward,
// y is up, origin at p0 on the outer face at ground level.
function wallFrame(p0, p1) {
  const a = P(p0[0], 0, p0[1]);
  const b = P(p1[0], 0, p1[1]);
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  const normal = new THREE.Vector3(-dir.z, 0, dir.x);
  const g = new THREE.Group();
  g.position.copy(a);
  g.rotation.y = Math.atan2(normal.x, normal.z);
  return { group: g, length: a.distanceTo(b) };
}

// plan coordinate along a wall -> metres from p0
function alongFn(p0, p1) {
  const axis = p0[0] === p1[0] ? 1 : 0;
  const c0 = p0[axis];
  const sign = Math.sign(p1[axis] - c0);
  return (c) => (c - c0) * sign * PX;
}

// ---------------------------------------------------------------- textures

function makeTextures() {
  const plaster = (base, amount, seed) =>
    canvasTexture(256, 256, (g, w, h) => {
      noiseFill(g, w, h, base, amount, 9000, seed, 2.5);
      // soft large-scale mottling
      const r = rng(seed + 7);
      for (let i = 0; i < 40; i++) {
        const x = r() * w, y = r() * h, rad = 20 + r() * 50;
        const grd = g.createRadialGradient(x, y, 0, x, y, rad);
        const a = (r() - 0.5) * amount * 0.6;
        grd.addColorStop(0, a > 0 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${-a})`);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
    }, 2.5);

  // grain kept soft and low-contrast: battens are seen at grazing angles
  const woodGrain = canvasTexture(64, 512, (g, w, h) => {
    g.fillStyle = '#c09165';
    g.fillRect(0, 0, w, h);
    g.filter = 'blur(2px)';
    const r = rng(11);
    for (let i = 0; i < 14; i++) {
      const x = r() * w;
      g.fillStyle = r() > 0.5 ? `rgba(110,70,35,${0.06 + r() * 0.08})` : `rgba(255,230,190,${0.05 + r() * 0.07})`;
      g.fillRect(x, 0, 3 + r() * 6, h);
    }
    g.filter = 'none';
  }, 1);

  const deck = canvasTexture(512, 256, (g, w, h) => {
    g.fillStyle = '#9b7550';
    g.fillRect(0, 0, w, h);
    const r = rng(5);
    const boards = 8;
    for (let b = 0; b < boards; b++) {
      const y = (b * h) / boards;
      g.fillStyle = `rgba(${r() > 0.5 ? '255,235,200' : '60,35,15'},${0.05 + r() * 0.08})`;
      g.fillRect(0, y, w, h / boards);
      g.fillStyle = 'rgba(40,25,12,0.7)';
      g.fillRect(0, y, w, 2);
      for (let i = 0; i < 12; i++) {
        g.fillStyle = `rgba(70,40,20,${0.05 + r() * 0.1})`;
        g.fillRect(0, y + 3 + r() * (h / boards - 6), w, 1);
      }
    }
  }, 1.4);

  const roof = canvasTexture(512, 512, (g) => {
    // 4 flat concrete tiles across x 4 courses
    const row = 128, tile = 128;
    for (let r = 0; r < 4; r++) {
      const y = r * row;
      const grad = g.createLinearGradient(0, y, 0, y + row);
      grad.addColorStop(0, '#6f7378');
      grad.addColorStop(0.8, '#62666b');
      grad.addColorStop(1, '#575b60');
      g.fillStyle = grad;
      g.fillRect(0, y, 512, row);
      g.fillStyle = 'rgba(15,17,20,0.6)';
      g.fillRect(0, y, 512, 8);
      g.fillStyle = 'rgba(15,17,20,0.25)';
      g.fillRect(0, y + 8, 512, 8);
      const off = (r % 2) * (tile / 2);
      g.fillStyle = 'rgba(30,33,37,0.55)';
      for (let x = -tile; x < 512 + tile; x += tile) g.fillRect(x + off, y, 3, row);
    }
  }, 1);
  roof.userData.size = [4 * 0.42, 4 * 0.4];

  // height map for the roof courses (bump)
  const roofBump = canvasTexture(512, 512, (g) => {
    for (let r = 0; r < 4; r++) {
      const y = r * 128;
      const grad = g.createLinearGradient(0, y, 0, y + 128);
      grad.addColorStop(0, '#202020');
      grad.addColorStop(0.12, '#ffffff');
      grad.addColorStop(1, '#bdbdbd');
      g.fillStyle = grad;
      g.fillRect(0, y, 512, 128);
      const off = (r % 2) * 64;
      g.fillStyle = '#707070';
      for (let x = -128; x < 640; x += 128) g.fillRect(x + off, y, 3, 128);
    }
  }, 1);
  roofBump.colorSpace = THREE.NoColorSpace;

  return {
    grey: plaster('#8e8f90', 0.16, 1),
    white: plaster('#ecebe7', 0.05, 2),
    plinth: plaster('#b7b7b2', 0.22, 3),
    chimney: plaster('#5d6064', 0.12, 4),
    woodGrain,
    deck,
    roof,
    roofBump,
  };
}

function makeMaterials() {
  const t = makeTextures();
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const M = {
    textures: t,
    grey: std({ map: t.grey, roughness: 0.95 }),
    white: std({ map: t.white, roughness: 0.92 }),
    trim: std({ color: '#f2f2ef', roughness: 0.6 }),
    plinth: std({ map: t.plinth, roughness: 1 }),
    woodBacking: std({ color: '#3a2b1f', roughness: 0.9 }),
    wood: std({ map: t.woodGrain, roughness: 0.75 }),
    woodSoffit: std({ map: t.woodGrain, color: '#b58a62', roughness: 0.8 }),
    frame: std({ color: '#3a3d41', roughness: 0.45, metalness: 0.35 }),
    glass: std({ color: '#7f93a2', roughness: 0.03, metalness: 0.9, envMapIntensity: 1.15 }),
    garage: std({ color: '#5a5d61', roughness: 0.55, metalness: 0.3 }),
    door: std({ color: '#3d4044', roughness: 0.5, metalness: 0.3 }),
    steel: std({ color: '#c9ccd0', roughness: 0.25, metalness: 1 }),
    dark: std({ color: '#3b3e42', roughness: 0.5, metalness: 0.4 }),
    gutter: std({ color: '#3b3e42', roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide }),
    soffit: std({ color: '#d9d9d6', roughness: 0.9 }),
    chimney: std({ map: t.chimney, roughness: 0.95 }),
    chimneyCap: std({ color: '#6e7276', roughness: 0.7, metalness: 0.2 }),
    roof: std({ map: t.roof, bumpMap: t.roofBump, bumpScale: 3, roughness: 0.8, side: THREE.DoubleSide }),
    cap: std({ color: '#45484c', roughness: 0.7, metalness: 0.2 }),
    deck: std({ map: t.deck, roughness: 0.85 }),
  };
  M.glass.userData.reflect = true;
  return M;
}

// ---------------------------------------------------------------- walls

function buildLowerWall(spec, M) {
  const { group, length } = wallFrame(spec.p0, spec.p1);
  const along = alongFn(spec.p0, spec.p1);
  const range = (a, b) => [Math.min(along(a), along(b)), Math.max(along(a), along(b))];
  const spans = spec.spans.map(([a, b, mat]) => ({ r: range(a, b), mat }));
  const openings = spec.openings.map((o) => ({ ...o, r: range(...o.at), v: [m(o.h[0]), m(o.h[1])] }));

  const eps = 0.003;
  const T = WALL_T;
  const base = m(H.plinth);
  const top = m(H.low);

  const cuts = new Set([0, length]);
  spans.forEach((s) => s.r.forEach((x) => cuts.add(Math.min(Math.max(x, 0), length))));
  openings.forEach((o) => o.r.forEach((x) => cuts.add(x)));
  const xs = [...cuts].sort((a, b) => a - b);

  const slats = [];
  for (let i = 0; i < xs.length - 1; i++) {
    let a = xs[i];
    let b = xs[i + 1];
    if (b - a < 1e-4) continue;
    const mid = (a + b) / 2;
    const span = spans.find((s) => s.r[0] <= mid && mid < s.r[1]) || spans[0];
    let solid = [[base, top]];
    for (const o of openings) {
      if (o.r[0] <= mid && mid < o.r[1]) {
        solid = solid.flatMap(([s0, s1]) => {
          const out = [];
          if (o.v[0] > s0) out.push([s0, Math.min(o.v[0], s1)]);
          if (o.v[1] < s1) out.push([Math.max(o.v[1], s0), s1]);
          return out.filter(([p, q]) => q - p > 1e-4);
        });
      }
    }
    if (a === 0) a += eps;
    if (b === length) b -= eps;
    for (const [s0, s1] of solid) {
      const mat = span.mat === 'wood' ? M.woodBacking : M[span.mat];
      group.add(worldUV(box(a, b, s0, s1, -T, 0, mat), 2.5));
      if (span.mat === 'wood') slats.push([a, b, s0, s1]);
    }
  }

  // vertical wood battens on the cladding
  if (slats.length) group.add(buildSlats(slats, M));

  // plinth band (continuous, also forms the thresholds)
  const pp = 0.025;
  group.add(worldUV(box(-pp, length + pp, 0, base, -T, pp, M.plinth), 2.5));

  for (const o of openings) buildOpening(group, o, along, M);
  return group;
}

function buildSlats(pieces, M) {
  const pitch = 0.1;
  const w = 0.058;
  const d = 0.035;
  const items = [];
  for (const [a, b, s0, s1] of pieces) {
    const n = Math.max(1, Math.floor((b - a) / pitch));
    const gap = (b - a - n * pitch) / 2;
    for (let k = 0; k < n; k++) {
      const x = a + gap + pitch * (k + 0.5);
      items.push([x, s0, s1]);
    }
  }
  const geo = new THREE.BoxGeometry(1, 1, 1);
  // stretch the grain vertically: uv y along height
  const mesh = new THREE.InstancedMesh(geo, M.wood, items.length);
  const mat4 = new THREE.Matrix4();
  const col = new THREE.Color();
  const r = rng(items.length * 31 + 7);
  items.forEach(([x, s0, s1], i) => {
    mat4.compose(
      new THREE.Vector3(x, (s0 + s1) / 2, d / 2),
      new THREE.Quaternion(),
      new THREE.Vector3(w, s1 - s0, d)
    );
    mesh.setMatrixAt(i, mat4);
    const k = 0.86 + r() * 0.24;
    col.setRGB(k, k * (0.97 + r() * 0.05), k * (0.93 + r() * 0.08));
    mesh.setColorAt(i, col);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Window / door / garage infill, recessed into the reveal.
function buildOpening(group, o, along, M) {
  const [u0, u1] = o.r;
  const [v0, v1] = o.v;
  const inset = 0.12; // depth of the reveal in front of the frame
  const f = 0.065; // frame face width
  const fd = 0.08; // frame depth
  const zf = -inset;

  if (o.type === 'garage') {
    const d = 0.18;
    const panels = 4;
    const ph = (v1 - v0) / panels;
    for (let i = 0; i < panels; i++) {
      group.add(box(u0, u1, v0 + i * ph + 0.012, v0 + (i + 1) * ph - 0.012, -d - 0.05, -d, M.garage));
    }
    group.add(box(u0, u1, v0, v1, -d - 0.08, -d - 0.05, M.dark)); // grooves read dark
    // head / jamb trim of the frame
    group.add(box(u0, u0 + 0.05, v0, v1, -d - 0.02, -d + 0.03, M.frame));
    group.add(box(u1 - 0.05, u1, v0, v1, -d - 0.02, -d + 0.03, M.frame));
    group.add(box(u0, u1, v1 - 0.05, v1, -d - 0.02, -d + 0.03, M.frame));
    return;
  }

  // outer frame
  group.add(box(u0, u0 + f, v0, v1, zf - fd, zf, M.frame));
  group.add(box(u1 - f, u1, v0, v1, zf - fd, zf, M.frame));
  group.add(box(u0, u1, v1 - f, v1, zf - fd, zf, M.frame));
  group.add(box(u0, u1, v0, v0 + f, zf - fd, zf, M.frame));

  if (o.type === 'door') {
    const leaf = box(u0 + f, u1 - f, v0 + f, v1 - f, zf - fd, zf - 0.03, M.door);
    group.add(leaf);
    if (o.glass) {
      const [g0, g1] = [along(o.glass[0]), along(o.glass[1])].sort((a, b) => a - b);
      group.add(box(g0, g1, v0 + 0.25, v1 - 0.2, zf - 0.035, zf - 0.025, M.glass));
    }
    if (o.handle !== undefined) {
      const hx = along(o.handle);
      const hy0 = v0 + 0.35 * (v1 - v0);
      const hy1 = v0 + 0.8 * (v1 - v0);
      group.add(pipe(new THREE.Vector3(hx, hy0, zf + 0.04), new THREE.Vector3(hx, hy1, zf + 0.04), 0.014, M.steel));
      group.add(box(hx - 0.01, hx + 0.01, hy0, hy0 + 0.02, zf - 0.03, zf + 0.04, M.steel));
      group.add(box(hx - 0.01, hx + 0.01, hy1 - 0.02, hy1, zf - 0.03, zf + 0.04, M.steel));
    }
    return;
  }

  // window glass + mullions
  group.add(box(u0 + f, u1 - f, v0 + f, v1 - f, zf - fd + 0.02, zf - fd + 0.035, M.glass));
  for (const mu of o.mullions || []) {
    const x = along(mu);
    group.add(box(x - f / 2, x + f / 2, v0, v1, zf - fd, zf, M.frame));
  }
  // sash frames just inside the outer frame give a second profile line
  const s = 0.03;
  group.add(box(u0 + f, u1 - f, v1 - f - s, v1 - f, zf - fd + 0.01, zf - 0.02, M.frame));
  group.add(box(u0 + f, u1 - f, v0 + f, v0 + f + s, zf - fd + 0.01, zf - 0.02, M.frame));

  if (o.sill) {
    const [a, b] = [along(o.sill[0]), along(o.sill[1])].sort((p, q) => p - q);
    group.add(box(a, b, v0 - 0.05, v0, zf, 0.07, M.frame));
  }
}

function buildUpperBand(p0, p1, M) {
  const { group, length } = wallFrame(p0, p1);
  const eps = 0.003;
  const T = WALL_T;
  group.add(worldUV(box(eps, length - eps, m(H.trim), m(H.wall), -T, 0, M.white), 2.5));
  const tp = 0.05;
  group.add(box(-tp, length + tp, m(H.low), m(H.trim), -T, tp, M.trim));
  return group;
}

// ---------------------------------------------------------------- roof

function roofFace(points, eaveDir, M) {
  const verts = points.map(([X, Y, Z]) => P(X, Y, Z));
  const n = new THREE.Vector3()
    .subVectors(verts[1], verts[0])
    .cross(new THREE.Vector3().subVectors(verts[2], verts[0]))
    .normalize();
  if (n.y < 0) verts.reverse();
  const e = new THREE.Vector3(eaveDir[0], 0, eaveDir[1]).normalize();
  const eaveY = Math.min(...verts.map((v) => v.y));
  const sinP = Math.sin(PITCH);
  const [su, sv] = M.textures.roof.userData.size;
  const pos = [];
  const uv = [];
  for (let i = 1; i < verts.length - 1; i++) {
    for (const v of [verts[0], verts[i], verts[i + 1]]) {
      pos.push(v.x, v.y, v.z);
      uv.push(v.dot(e) / su, (v.y - eaveY) / sinP / sv);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return shadow(new THREE.Mesh(geo, M.roof));
}

function buildRoof(M) {
  const g = new THREE.Group();
  const W = WING;
  const E = H.wall + FASCIA;
  const run = (W.x1 - W.x0) / 2 + OVERHANG;
  const R = E + run * Math.tan(PITCH);
  const we = { x0: W.x0 - OVERHANG, x1: W.x1 + OVERHANG, z0: W.z0 - OVERHANG, z1: W.z1 + OVERHANG };
  const mz = (MAIN.z0 + MAIN.z1) / 2;
  const me = { x1: MAIN.x1 + OVERHANG, z0: mz - run, z1: mz + run };
  const ridgeX = (we.x0 + we.x1) / 2;
  const wr0 = we.z0 + run;
  const wr1 = we.z1 - run;
  const mr1 = me.x1 - run;

  // wing: hip roof, ridge north-south
  g.add(roofFace([[we.x0, E, we.z0], [we.x0, E, we.z1], [ridgeX, R, wr1], [ridgeX, R, wr0]], [0, 1], M));
  g.add(roofFace([[we.x1, E, we.z1], [we.x1, E, we.z0], [ridgeX, R, wr0], [ridgeX, R, wr1]], [0, -1], M));
  g.add(roofFace([[we.x0, E, we.z1], [we.x1, E, we.z1], [ridgeX, R, wr1]], [1, 0], M));
  g.add(roofFace([[we.x1, E, we.z0], [we.x0, E, we.z0], [ridgeX, R, wr0]], [-1, 0], M));
  // main body: ridge east-west running into the wing roof, hip to the east
  g.add(roofFace([[ridgeX, E, me.z1], [me.x1, E, me.z1], [mr1, R, mz], [ridgeX, R, mz]], [1, 0], M));
  g.add(roofFace([[me.x1, E, me.z0], [ridgeX, E, me.z0], [ridgeX, R, mz], [mr1, R, mz]], [-1, 0], M));
  g.add(roofFace([[me.x1, E, me.z1], [me.x1, E, me.z0], [mr1, R, mz]], [0, -1], M));

  // ridge / hip / valley caps
  const lift = new THREE.Vector3(0, 0.05, 0);
  const cap = (a, b, w = 0.2, h = 0.1) => g.add(bar(P(...a).add(lift), P(...b).add(lift), w, h, M.cap));
  cap([ridgeX, R, wr0], [ridgeX, R, wr1]);
  cap([we.x0, E, we.z0], [ridgeX, R, wr0]);
  cap([we.x1, E, we.z0], [ridgeX, R, wr0]);
  cap([we.x0, E, we.z1], [ridgeX, R, wr1]);
  cap([we.x1, E, we.z1], [ridgeX, R, wr1]);
  cap([ridgeX, R, mz], [mr1, R, mz]);
  cap([me.x1, E, me.z0], [mr1, R, mz]);
  cap([me.x1, E, me.z1], [mr1, R, mz]);
  cap([we.x1, E, me.z0], [ridgeX, R, mz], 0.16, 0.03); // valleys (flashing)
  cap([we.x1, E, me.z1], [ridgeX, R, mz], 0.16, 0.03);

  // fascia boards and half-round gutters along every eave
  const fasciaH = m(FASCIA);
  const eave = (X0, Z0, X1, Z1, out) => {
    const a = P(X0, H.wall, Z0);
    const b = P(X1, H.wall, Z1);
    const alongX = Math.abs(b.x - a.x) > Math.abs(b.z - a.z);
    const len = a.distanceTo(b);
    const cx = (a.x + b.x) / 2;
    const cz = (a.z + b.z) / 2;
    const f = box(-len / 2 - 0.02, len / 2 + 0.02, 0, fasciaH, -0.05, 0.02, M.dark);
    const fg = new THREE.Group();
    fg.position.set(cx, a.y, cz);
    fg.rotation.y = alongX ? (out > 0 ? 0 : Math.PI) : out > 0 ? Math.PI / 2 : -Math.PI / 2;
    fg.add(f);
    // gutter: open half pipe hanging off the fascia
    const gut = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, len + 0.04, 16, 1, false, Math.PI, Math.PI),
      M.gutter
    );
    gut.rotation.z = Math.PI / 2;
    gut.position.set(0, fasciaH - 0.02, 0.1);
    fg.add(shadow(gut));
    g.add(fg);
  };
  eave(we.x0, we.z0, we.x0, we.z1, -1); // west (normal -x)
  eave(we.x0, we.z1, we.x1, we.z1, 1); // south
  eave(we.x0, we.z0, we.x1, we.z0, -1); // north
  eave(we.x1, we.z0, we.x1, me.z0, 1); // wing east (north part)
  eave(we.x1, me.z1, we.x1, we.z1, 1); // wing east (south part)
  eave(we.x1, me.z1, me.x1, me.z1, 1); // main south
  eave(we.x1, me.z0, me.x1, me.z0, -1); // main north
  eave(me.x1, me.z0, me.x1, me.z1, 1); // main east

  // soffits under the overhangs
  const soffit = (X0, X1, Z0, Z1) => {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(m(X1 - X0), m(Z1 - Z0)), M.soffit);
    s.rotation.x = Math.PI / 2;
    s.position.set(wx((X0 + X1) / 2), m(H.wall), wz((Z0 + Z1) / 2));
    g.add(shadow(s, false, true));
  };
  soffit(we.x0, we.x1, we.z0, we.z1);
  soffit(W.x1, me.x1, me.z0, me.z1);

  // chimneys
  for (const [X0, X1, Z0, Z1] of CHIMNEYS) {
    const y0 = m(R - 90);
    const y1 = m(CHIMNEY_TOP);
    const c = worldUV(box(wx(X0), wx(X1), y0, y1, wz(Z0), wz(Z1), M.chimney), 2.5);
    g.add(c);
    g.add(box(wx(X0) - 0.05, wx(X1) + 0.05, y1, y1 + 0.08, wz(Z0) - 0.05, wz(Z1) + 0.05, M.chimneyCap));
  }
  return g;
}

// ---------------------------------------------------------------- house

export function buildHouse() {
  const M = makeMaterials();
  const house = new THREE.Group();

  for (const spec of LOWER_WALLS) house.add(buildLowerWall(spec, M));
  for (const [p0, p1] of UPPER_WALLS) house.add(buildUpperBand(p0, p1, M));

  // entrance porch: corner pillar, wooden ceiling, raised floor + step
  house.add(worldUV(box(wx(PILLAR.x0), wx(PILLAR.x1), m(H.plinth), m(H.low), wz(PILLAR.z0), wz(PILLAR.z1), M.white), 2.5));
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(m(PORCH.x1 - PORCH.x0), m(PORCH.z1 - PORCH.z0)), M.woodSoffit);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(wx((PORCH.x0 + PORCH.x1) / 2), m(H.low) - 0.002, wz((PORCH.z0 + PORCH.z1) / 2));
  house.add(shadow(ceil, false, true));
  house.add(worldUV(box(wx(PORCH.x0), wx(PORCH.x1 + 2), 0, m(H.plinth), wz(PORCH.z0), wz(PORCH.z1), M.plinth), 2.5));
  house.add(worldUV(box(wx(PORCH.x0 - 4), wx(PORCH.x1 + 10), 0, m(H.plinth) / 2, wz(PORCH.z1), wz(PORCH.z1 + 18), M.plinth), 2.5));

  // garden terrace deck
  house.add(worldUV(box(wx(DECK.x0), wx(DECK.x1), 0, m(H.plinth) - 0.01, wz(DECK.z0), wz(DECK.z1), M.deck), 1.4));

  // downspouts
  for (const d of DOWNSPOUTS) {
    // gutter outlet -> drop below the soffit -> offset back to the wall -> down
    const r = 0.05;
    const outlet = P(d.to[0], H.wall + 9, d.to[1]);
    const drop = P(d.to[0], H.wall - 8, d.to[1]);
    const knee = P(d.at[0], H.wall - 30, d.at[1]);
    const foot = P(d.at[0], 0, d.at[1]);
    house.add(pipe(outlet, drop, r, M.dark));
    house.add(pipe(drop, knee, r, M.dark));
    house.add(pipe(knee, foot, r, M.dark));
    // wall brackets
    for (const hy of [40, 100, 150]) {
      const c = P(d.at[0], hy, d.at[1]);
      house.add(pipe(c.clone().add(new THREE.Vector3(0, -0.03, 0)), c.clone().add(new THREE.Vector3(0, 0.03, 0)), r * 1.3, M.dark));
    }
  }

  house.add(buildRoof(M));
  return { house, materials: M };
}

// turntable framing for this house
export const ORBIT = { radius: 33, height: 9.2, fov: 30, target: [0, 2.2, 0] };

// plan extent in metres, for framing the camera
export const EXTENT = {
  width: m(MAIN.x1 - WING.x0 + 2 * OVERHANG),
  depth: m(WING.z1 - WING.z0 + 2 * OVERHANG),
};
