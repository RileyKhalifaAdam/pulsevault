// Tooling smoke test: a lit, bloom-less cube. Proves three.js + esbuild + headless WebGL2 screenshots work.
import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(2.2, 1.6, 3);
camera.lookAt(0, 0, 0);
scene.add(new THREE.DirectionalLight(0xffc49a, 3).translateX(3).translateY(4).translateZ(2));
scene.add(new THREE.AmbientLight(0x223344, 1));
const cube = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.7, roughness: 0.35 }));
scene.add(cube);

let frames = 0;
renderer.setAnimationLoop(() => {
  cube.rotation.y += 0.01;
  renderer.render(scene, camera);
  if (++frames === 2) (window as any).__ready = true;
});
