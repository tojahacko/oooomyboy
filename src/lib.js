// Geometry and texture helpers shared by the house models.
import * as THREE from 'three';

export function shadow(mesh, cast = true, receive = true) {
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

// Box in a local frame given min/max corners (metres).
export function box(x0, x1, y0, y1, z0, z1, material) {
  const g = new THREE.BoxGeometry(Math.max(x1 - x0, 1e-4), Math.max(y1 - y0, 1e-4), Math.max(z1 - z0, 1e-4));
  const mesh = new THREE.Mesh(g, material);
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return shadow(mesh);
}

// Cylinder between two points.
export function pipe(a, b, r, material) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 12);
  const mesh = new THREE.Mesh(g, material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3().subVectors(b, a).normalize());
  return shadow(mesh);
}

export function canvasTexture(w, h, draw, repeatMetres) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.userData.metres = repeatMetres;
  return t;
}

// deterministic pseudo random
export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function noiseFill(g, w, h, base, amount, count, seed, blobs = 1.5) {
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const v = (r() - 0.5) * amount;
    g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    const s = r() * blobs + 0.6;
    g.fillRect(r() * w, r() * h, s, s);
  }
}

// UV helper: world-scale planar mapping for boxes (texture repeats every
// `metres`), so plaster/wood texture density is identical everywhere.
export function worldUV(mesh, metres) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  mesh.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nrm, i);
    // local-to-parent offset so neighbouring boxes line up
    const q = p.clone().add(mesh.position);
    let u, v;
    if (Math.abs(n.y) > 0.5) [u, v] = [q.x, q.z];
    else if (Math.abs(n.x) > 0.5) [u, v] = [q.z, q.y];
    else [u, v] = [q.x, q.y];
    uv.setXY(i, u / metres, v / metres);
  }
  uv.needsUpdate = true;
  return mesh;
}

// bar between two world points (ridge / hip / valley caps)
export function bar(a, b, w, h, material) {
  const len = a.distanceTo(b);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, len), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.lookAt(b);
  return shadow(mesh);
}
