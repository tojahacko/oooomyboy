// 3D model of "Dom w macierzankach 5 (G2)" rebuilt from its four elevations.
//
// All plan measurements are in elevation pixels (the drawings are ~55 px/m)
// and converted to metres at the end. Plan axes: X runs west -> east,
// Zn runs north -> south (the front / garage side is south).
//
//        north
//   +-----------+
//   |           |
//   |           +---------+
//   |   wing    |  main   |   east
//   |  (garage) |  body   |
//   |           +---------+
//   |           |
//   +-----------+
//        south (front)

import * as THREE from 'three';

const PX = 1 / 55; // metres per elevation pixel

// footprint (walls)
const WING = { x0: 0, x1: 490, z0: 0, z1: 1058 };
const MAIN = { x0: 490, x1: 874, z0: 280, z1: 770 };

const WALL_H = 188; // soffit height
const FASCIA = 14; // fascia band, roof eave sits on top of it
const OVERHANG = 46;
const PITCH = Math.atan(0.584); // ~30 deg, measured from the elevations
const CHIMNEY_TOP = 394;

// chimneys: [x0, x1, z0, z1] in plan pixels
const CHIMNEYS = [
  [207, 253, 638, 689],
  [289, 332, 337, 380],
  [494, 559, 571, 610],
];

const CX = (WING.x0 - OVERHANG + MAIN.x1 + OVERHANG) / 2;
const CZ = (WING.z0 + WING.z1) / 2;

// plan pixels -> world metres (three.js: y up, +z towards the front)
const wx = (X) => (X - CX) * PX;
const wz = (Z) => (Z - CZ) * PX;
const wy = (Y) => Y * PX;
const P = (X, Y, Z) => new THREE.Vector3(wx(X), wy(Y), wz(Z));

// Static "sun" used to bake flat shading into every face, so the look does
// not depend on the renderer's lighting model and stays fast in software GL.
const SUN = new THREE.Vector3(-0.55, 0.75, 0.65).normalize();
const SUN_FLAT = new THREE.Vector3(SUN.x, 0, SUN.z).normalize();

function wallShade(normal) {
  return 0.8 + 0.22 * Math.max(0, normal.dot(SUN_FLAT));
}

function surfaceShade(normal, ambient = 0.62, direct = 0.42) {
  return Math.min(1.06, ambient + direct * Math.max(0, normal.dot(SUN)));
}

// ---------------------------------------------------------------- textures

function roofTileTexture() {
  // 4 tiles across x 4 courses; concrete flat tile, dark graphite
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const row = 128;
  const tile = 128;
  for (let r = 0; r < 4; r++) {
    const y = r * row;
    const grad = g.createLinearGradient(0, y, 0, y + row);
    grad.addColorStop(0, '#7a7e83');
    grad.addColorStop(0.75, '#686c71');
    grad.addColorStop(1, '#5a5e63');
    g.fillStyle = grad;
    g.fillRect(0, y, 512, row);
    // shadow cast by the course above
    g.fillStyle = 'rgba(20,22,25,0.55)';
    g.fillRect(0, y, 512, 9);
    g.fillStyle = 'rgba(20,22,25,0.25)';
    g.fillRect(0, y + 9, 512, 7);
    // butt joints, staggered every course
    const off = (r % 2) * (tile / 2);
    g.fillStyle = 'rgba(35,38,42,0.55)';
    for (let x = -tile; x < 512 + tile; x += tile) g.fillRect(x + off, y, 3, row);
    // subtle per-tile variation
    for (let x = -tile; x < 512; x += tile) {
      const k = ((r * 7 + x * 13) % 5) / 5;
      g.fillStyle = `rgba(255,255,255,${0.02 + 0.03 * k})`;
      g.fillRect(x + off + 3, y + 16, tile - 3, row - 16);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const TILE_REPEAT_U = 4 * 0.42; // metres covered by the texture across
const TILE_REPEAT_V = 4 * 0.4; // ... and up the slope

// ---------------------------------------------------------------- geometry

// A planar roof face (convex polygon given in plan pixels + height pixels).
// UVs: u along the eave, v up the slope, so tile courses stay horizontal.
function roofFace(points, eaveDir, material) {
  const verts = points.map(([X, Y, Z]) => P(X, Y, Z));
  const n = new THREE.Vector3()
    .subVectors(verts[1], verts[0])
    .cross(new THREE.Vector3().subVectors(verts[2], verts[0]))
    .normalize();
  if (n.y < 0) {
    verts.reverse();
    n.negate();
  }
  const e = new THREE.Vector3(eaveDir[0], 0, eaveDir[1]).normalize();
  const eaveY = Math.min(...verts.map((v) => v.y));
  const sinP = Math.sin(PITCH);
  const pos = [];
  const uv = [];
  for (let i = 1; i < verts.length - 1; i++) {
    for (const v of [verts[0], verts[i], verts[i + 1]]) {
      pos.push(v.x, v.y, v.z);
      uv.push(v.dot(e) / TILE_REPEAT_U, (v.y - eaveY) / sinP / TILE_REPEAT_V);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const mat = material.clone();
  mat.color.setScalar(surfaceShade(n));
  return new THREE.Mesh(geo, mat);
}

// Box with baked per-face shading (chimneys, fascia, caps...)
function shadedBox(w, h, d, color, shadeFn = surfaceShade) {
  const geo = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const base = new THREE.Color(color);
  const nrm = geo.getAttribute('normal');
  const cols = [];
  const n = new THREE.Vector3();
  for (let i = 0; i < nrm.count; i++) {
    n.fromBufferAttribute(nrm, i);
    const s = shadeFn(n);
    cols.push(base.r * s, base.g * s, base.b * s);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
}

// Thin bar between two world points (ridge / hip / valley caps)
function bar(a, b, thickness, color) {
  const len = a.distanceTo(b);
  const m = shadedBox(thickness, thickness * 0.7, len, color);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.lookAt(b);
  return m;
}

function wall(texture, X0, Z0, X1, Z1) {
  // wall from (X0,Z0) to (X1,Z1) as seen from outside, left to right
  const a = P(X0, 0, Z0);
  const b = P(X1, 0, Z1);
  const len = a.distanceTo(b);
  const geo = new THREE.PlaneGeometry(len, wy(WALL_H));
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  const normal = new THREE.Vector3(-dir.z, 0, dir.x); // outward
  const mat = new THREE.MeshBasicMaterial({ map: texture });
  mat.color.setScalar(wallShade(normal));
  const m = new THREE.Mesh(geo, mat);
  m.position.set((a.x + b.x) / 2, wy(WALL_H) / 2, (a.z + b.z) / 2);
  m.rotation.y = Math.atan2(normal.x, normal.z);
  return m;
}

// ---------------------------------------------------------------- house

export function buildHouse(textureBase = 'textures/') {
  const house = new THREE.Group();
  const manager = new THREE.LoadingManager();
  const ready = new Promise((res, rej) => {
    manager.onLoad = res;
    manager.onError = (u) => rej(new Error('failed to load ' + u));
  });
  const loader = new THREE.TextureLoader(manager);
  const tex = (name) => {
    const t = loader.load(`${textureBase}${name}.jpg`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };

  const W = WING;
  const M = MAIN;

  // --- walls (textures cut from the elevations, left->right from outside)
  house.add(wall(tex('front_wing'), W.x0, W.z1, W.x1, W.z1));
  house.add(wall(tex('front_main'), M.x0, M.z1, M.x1, M.z1));
  house.add(wall(tex('east_wing_s'), W.x1, W.z1, W.x1, M.z1));
  house.add(wall(tex('east_main'), M.x1, M.z1, M.x1, M.z0));
  house.add(wall(tex('east_wing_n'), W.x1, M.z0, W.x1, W.z0));
  house.add(wall(tex('rear_main'), M.x1, M.z0, M.x0, M.z0));
  house.add(wall(tex('rear_wing'), W.x1, W.z0, W.x0, W.z0));
  house.add(wall(tex('west_wing'), W.x0, W.z0, W.x0, W.z1));

  // --- roof
  const E = WALL_H + FASCIA; // eave height
  const run = (W.x1 - W.x0) / 2 + OVERHANG; // same span for both roofs
  const R = E + run * Math.tan(PITCH); // ridge height

  const we = { x0: W.x0 - OVERHANG, x1: W.x1 + OVERHANG, z0: W.z0 - OVERHANG, z1: W.z1 + OVERHANG };
  const me = { x1: M.x1 + OVERHANG, z0: M.z0 - OVERHANG, z1: M.z1 + OVERHANG };
  const ridgeX = (we.x0 + we.x1) / 2;
  const wr0 = we.z0 + run; // wing ridge ends
  const wr1 = we.z1 - run;
  const mz = (me.z0 + me.z1) / 2;
  const mr1 = me.x1 - run; // main ridge east end

  const roofMat = new THREE.MeshBasicMaterial({ map: roofTileTexture(), side: THREE.DoubleSide });

  // wing: long hip roof, ridge north-south
  house.add(roofFace([[we.x0, E, we.z0], [we.x0, E, we.z1], [ridgeX, R, wr1], [ridgeX, R, wr0]], [0, 1], roofMat)); // west
  house.add(roofFace([[we.x1, E, we.z1], [we.x1, E, we.z0], [ridgeX, R, wr0], [ridgeX, R, wr1]], [0, -1], roofMat)); // east
  house.add(roofFace([[we.x0, E, we.z1], [we.x1, E, we.z1], [ridgeX, R, wr1]], [1, 0], roofMat)); // south hip
  house.add(roofFace([[we.x1, E, we.z0], [we.x0, E, we.z0], [ridgeX, R, wr0]], [-1, 0], roofMat)); // north hip

  // main body: ridge east-west, dies into the wing roof, hip on the east
  house.add(roofFace([[ridgeX, E, me.z1], [me.x1, E, me.z1], [mr1, R, mz], [ridgeX, R, mz]], [1, 0], roofMat)); // south
  house.add(roofFace([[me.x1, E, me.z0], [ridgeX, E, me.z0], [ridgeX, R, mz], [mr1, R, mz]], [-1, 0], roofMat)); // north
  house.add(roofFace([[me.x1, E, me.z1], [me.x1, E, me.z0], [mr1, R, mz]], [0, -1], roofMat)); // east hip

  // ridge, hip and valley caps
  const cap = '#44474b';
  const capT = 0.14;
  const lift = new THREE.Vector3(0, 0.03, 0);
  const capLine = (a, b) => house.add(bar(P(...a).add(lift), P(...b).add(lift), capT, cap));
  capLine([ridgeX, R, wr0], [ridgeX, R, wr1]);
  capLine([we.x0, E, we.z0], [ridgeX, R, wr0]);
  capLine([we.x1, E, we.z0], [ridgeX, R, wr0]);
  capLine([we.x0, E, we.z1], [ridgeX, R, wr1]);
  capLine([we.x1, E, we.z1], [ridgeX, R, wr1]);
  capLine([ridgeX, R, mz], [mr1, R, mz]);
  capLine([me.x1, E, me.z0], [mr1, R, mz]);
  capLine([me.x1, E, me.z1], [mr1, R, mz]);
  capLine([we.x1, E, me.z0], [ridgeX, R, mz]); // valleys
  capLine([we.x1, E, me.z1], [ridgeX, R, mz]);

  // fascia + gutter along every eave line
  const fasciaCol = '#3e4145';
  const fasciaH = wy(FASCIA);
  const fasciaRun = (X0, Z0, X1, Z1) => {
    const a = P(X0, WALL_H, Z0);
    const b = P(X1, WALL_H, Z1);
    const len = a.distanceTo(b) + 0.06;
    const alongX = Math.abs(b.x - a.x) > Math.abs(b.z - a.z);
    const m = shadedBox(alongX ? len : 0.07, fasciaH, alongX ? 0.07 : len, fasciaCol);
    m.position.set((a.x + b.x) / 2, a.y + fasciaH / 2, (a.z + b.z) / 2);
    house.add(m);
    const g = shadedBox(alongX ? len : 0.13, 0.12, alongX ? 0.13 : len, '#35383c');
    g.position.set(m.position.x, a.y + 0.09, m.position.z);
    house.add(g);
  };
  fasciaRun(we.x0, we.z0, we.x0, we.z1);
  fasciaRun(we.x0, we.z1, we.x1, we.z1);
  fasciaRun(we.x0, we.z0, we.x1, we.z0);
  fasciaRun(we.x1, we.z0, we.x1, me.z0);
  fasciaRun(we.x1, me.z1, we.x1, we.z1);
  fasciaRun(we.x1, me.z1, me.x1, me.z1);
  fasciaRun(we.x1, me.z0, me.x1, me.z0);
  fasciaRun(me.x1, me.z0, me.x1, me.z1);

  // soffits (underside of the overhang)
  const soffitMat = new THREE.MeshBasicMaterial({ color: '#8f959c', side: THREE.DoubleSide });
  const soffit = (X0, X1, Z0, Z1) => {
    const g = new THREE.PlaneGeometry((X1 - X0) * PX, (Z1 - Z0) * PX);
    const m = new THREE.Mesh(g, soffitMat);
    m.rotation.x = Math.PI / 2;
    m.position.set(wx((X0 + X1) / 2), wy(WALL_H) + 0.005, wz((Z0 + Z1) / 2));
    house.add(m);
  };
  soffit(we.x0, we.x1, we.z0, we.z1);
  soffit(W.x1, me.x1, me.z0, me.z1);

  // chimneys
  for (const [X0, X1, Z0, Z1] of CHIMNEYS) {
    const h = CHIMNEY_TOP - (R - 90);
    const c = shadedBox((X1 - X0) * PX, h * PX, (Z1 - Z0) * PX, '#5b5e62');
    c.position.set(wx((X0 + X1) / 2), wy(CHIMNEY_TOP - h / 2), wz((Z0 + Z1) / 2));
    house.add(c);
    const top = shadedBox((X1 - X0) * PX + 0.1, 0.1, (Z1 - Z0) * PX + 0.1, '#6c7074');
    top.position.set(c.position.x, wy(CHIMNEY_TOP) + 0.02, c.position.z);
    house.add(top);
  }

  // soft contact shadow on the ground
  house.add(contactShadow());

  return { house, ready, size: { ridge: wy(R) } };
}

function contactShadow() {
  const margin = 420; // px of plan around the house
  const X0 = WING.x0 - margin;
  const X1 = MAIN.x1 + margin;
  const Z0 = WING.z0 - margin;
  const Z1 = WING.z1 + margin;
  const scale = 0.5; // canvas px per plan px
  const c = document.createElement('canvas');
  c.width = Math.round((X1 - X0) * scale);
  c.height = Math.round((Z1 - Z0) * scale);
  const g = c.getContext('2d');
  const rect = (r, grow, alpha, dx = 0, dz = 0) => {
    g.fillStyle = `rgba(0,0,0,${alpha})`;
    g.fillRect(
      (r.x0 - grow - X0 + dx) * scale,
      (r.z0 - grow - Z0 + dz) * scale,
      (r.x1 - r.x0 + 2 * grow) * scale,
      (r.z1 - r.z0 + 2 * grow) * scale
    );
  };
  // wide soft shadow, offset away from the sun
  g.filter = 'blur(45px)';
  rect(WING, 40, 0.16, 50, -40);
  rect(MAIN, 40, 0.16, 50, -40);
  // tight contact darkening
  g.filter = 'blur(6px)';
  rect(WING, 4, 0.3);
  rect(MAIN, 4, 0.3);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry((X1 - X0) * PX, (Z1 - Z0) * PX),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(wx((X0 + X1) / 2), 0.002, wz((Z0 + Z1) / 2));
  m.renderOrder = -1;
  return m;
}
