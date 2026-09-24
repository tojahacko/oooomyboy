// Shared scene setup: white studio backdrop + orbit camera, like the
// archon.pl 360 viewer.
import * as THREE from 'three';
import { buildHouse } from './house.js';

export const ORBIT = {
  radius: 31, // metres from the house centre
  height: 8.5, // camera height
  target: new THREE.Vector3(0, 2.6, 0),
  startAngle: THREE.MathUtils.degToRad(-38), // front-left three-quarter view
};

export async function createScene(canvas, { width, height, pixelRatio = 1 } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor('#ffffff');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, width / height, 0.5, 400);

  const { house, ready } = buildHouse('textures/');
  scene.add(house);
  await ready;

  // angle 0 = looking at the front; increases counter-clockwise seen from above
  function setOrbit(angle) {
    const a = ORBIT.startAngle + angle;
    camera.position.set(Math.sin(a) * ORBIT.radius, ORBIT.height, Math.cos(a) * ORBIT.radius);
    camera.lookAt(ORBIT.target);
  }

  function resize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  setOrbit(0);
  return { renderer, scene, camera, setOrbit, resize, render: () => renderer.render(scene, camera) };
}
