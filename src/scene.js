// Studio scene: neutral white backdrop, sun + sky lighting with real shadows,
// and a turntable camera that orbits the fixed house at constant height,
// radius and focal length (angle 0 = front elevation, 90 = east/right,
// 180 = rear, 270 = west/left).
import * as THREE from 'three';
import { buildHouse } from './house.js';

export const ORBIT = {
  radius: 33,
  height: 9.2,
  fov: 30,
  target: new THREE.Vector3(0, 2.2, 0),
};

// Equirectangular environments. `lighting` is a neutral studio sky that lights
// the model without tinting it; `reflection` is what the glazing mirrors: sky
// with a tree line placed just below the horizon, because a camera looking
// slightly down sees reflections from slightly below the horizon.
function equirect(draw) {
  const w = 2048, h = 1024;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function lightingEnvironment() {
  return equirect((g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#c7d9ee');
    grd.addColorStop(0.48, '#f1f3f5');
    grd.addColorStop(0.52, '#d8d7d2');
    grd.addColorStop(1, '#b9b8b2');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
}

function reflectionEnvironment() {
  return equirect((g, w, h) => {
    let s = 17;
    const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const deg = (d) => h / 2 - (d / 90) * (h / 2); // elevation angle -> y
    // A flat window mirrors only a few degrees of the environment, so the
    // features here are large: sky down to ~-12 deg, big tree crowns
    // breaking the skyline, dense canopy below.
    const skyTo = deg(-24);
    const sky = g.createLinearGradient(0, 0, 0, skyTo);
    sky.addColorStop(0, '#3a73bd');
    sky.addColorStop(0.75, '#86b4e0');
    sky.addColorStop(1, '#cfe2f3');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, skyTo);
    for (let i = 0; i < 40; i++) {
      const x = r() * w, y = deg(-10 + r() * 40), rad = 20 + r() * 40;
      g.fillStyle = `rgba(255,255,255,${0.5 + r() * 0.4})`;
      g.beginPath();
      g.ellipse(x, y, rad * 2.2, rad * 0.8, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#6d7d62';
    g.fillRect(0, skyTo, w, h);
    for (let i = 0; i < 34; i++) {
      const x = r() * w, top = -13 - r() * 13, rad = 22 + r() * 40;
      for (let k = 0; k < 10; k++) {
        const kk = r();
        g.fillStyle = `rgb(${58 + kk * 70},${82 + kk * 80},${52 + kk * 45})`;
        g.beginPath();
        g.arc(x + (r() - 0.5) * rad * 1.6, deg(top - r() * 14), rad * (0.45 + r() * 0.55), 0, Math.PI * 2);
        g.fill();
      }
    }
    const lawn = g.createLinearGradient(0, deg(-40), 0, h);
    lawn.addColorStop(0, '#5e7d45');
    lawn.addColorStop(1, '#8a9478');
    g.fillStyle = lawn;
    g.fillRect(0, deg(-40), w, h);
  });
}

export async function createScene(canvas, { width, height, pixelRatio = 1 } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#ffffff');
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(lightingEnvironment()).texture;
  scene.environmentIntensity = 1.0;

  // sun: high, from the front-left, fixed in the world
  const sun = new THREE.DirectionalLight('#fff7ec', 2.1);
  sun.position.set(-12, 30, 15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -19; sc.right = 19; sc.top = 19; sc.bottom = -19; sc.near = 1; sc.far = 80;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 5;
  sun.shadow.blurSamples = 16;
  scene.add(sun);

  // ground: invisible except for the shadows it catches
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: 0.14 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const { house, materials } = buildHouse();
  materials.glass.envMap = pmrem.fromEquirectangular(reflectionEnvironment()).texture;
  materials.glass.needsUpdate = true;
  scene.add(house);

  const camera = new THREE.PerspectiveCamera(ORBIT.fov, width / height, 0.5, 400);

  function setOrbit(angle) {
    camera.position.set(Math.sin(angle) * ORBIT.radius, ORBIT.height, Math.cos(angle) * ORBIT.radius);
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
