// FitCheck exporter page (spec 6.5). Runs in headless Chromium, because three.js USDZExporter needs
// a real canvas for textures (it fails in plain Node).
//
//   window.exportItem({ glbB64 | glbUrl, w_in, d_in, h_in, category, dims_source, orient_override, yaw_deg })
//   window.exportSet({ items: [{ ...same as exportItem, x_in, y_in, z_in, yaw_deg }] })   // corner sets
//
// Both compose everything in three.js and export ONCE (stitching finished USDZ files with USD
// references drops materials).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { ORIENTATIONS, chooseOrientation, pivotAndScale, targetDims, IN_TO_M } from './orient.js';

const priors = await (await fetch('./priors.json')).json();
const MIN_ROUGHNESS = 0.6;

function b64ToBuffer(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function bufferToB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}

async function loadGlb({ glbB64, glbUrl }) {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('./vendor/jsm/libs/draco/');
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  let buffer;
  if (glbB64) buffer = b64ToBuffer(glbB64);
  else {
    const r = await fetch(glbUrl);
    if (!r.ok) throw new Error(`GLB fetch failed: ${r.status}`);
    buffer = await r.arrayBuffer();
  }
  const gltf = await loader.parseAsync(buffer, '');
  draco.dispose();
  return gltf.scene || gltf.scenes[0];
}

// Step 2: fix materials. glTF's default metallic value is 1 (renders black / dark chrome in AR),
// USDZ has no double-sided materials, and USDZExporter only understands MeshStandardMaterial.
function fixMaterials(root) {
  const stats = { meshes: 0, triangles: 0, materials: 0, textures: 0, max_metalness: 0, min_roughness: 1, removed: 0 };
  const seen = new Map();
  const drop = [];
  root.traverse((o) => {
    if (o.isLight || o.isCamera || o.isPoints || o.isLine) { drop.push(o); return; }
    if (!o.isMesh) return;
    const g = o.geometry;
    if (!g || !g.attributes.position || g.attributes.position.count < 3) { drop.push(o); return; }
    if (!g.attributes.normal) g.computeVertexNormals();
    stats.meshes += 1;
    stats.triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const fix = (m) => {
      if (!m) m = new THREE.MeshStandardMaterial({ color: 0xb0a090 });
      if (seen.has(m)) return seen.get(m);
      let out = m;
      if (!m.isMeshStandardMaterial) {
        out = new THREE.MeshStandardMaterial({ color: m.color ? m.color.clone() : new THREE.Color(0xffffff), map: m.map || null });
        out.name = m.name;
      }
      out.metalness = 0;
      out.metalnessMap = null;
      out.roughness = Math.max(out.roughness ?? 1, MIN_ROUGHNESS);
      out.roughnessMap = null;            // a packed metallicRoughness map would bring the metal look back
      if (out.map && !g.attributes.uv) out.map = null;
      if (out.map) out.color.set(0xffffff);
      out.side = THREE.FrontSide;
      out.transparent = false;
      out.opacity = 1;
      out.alphaTest = 0;
      out.transmission = 0;
      out.needsUpdate = true;
      seen.set(m, out);
      stats.materials += 1;
      if (out.map) stats.textures += 1;
      stats.max_metalness = Math.max(stats.max_metalness, out.metalness);
      stats.min_roughness = Math.min(stats.min_roughness, out.roughness);
      return out;
    };
    // USDZExporter handles one material per mesh
    o.material = Array.isArray(o.material) ? fix(o.material[0]) : fix(o.material);
  });
  for (const o of drop) { if (o.parent) o.parent.remove(o); stats.removed += 1; }
  if (stats.meshes === 0) throw new Error('GLB has no meshes');
  return stats;
}

function preciseBox(obj) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj, true);
  if (box.isEmpty()) throw new Error('empty bounding box');
  return { min: box.min.toArray(), max: box.max.toArray() };
}

function applyOrientation(group, name) {
  const def = ORIENTATIONS.find((o) => o[0] === name);
  if (!def || !def[1]) return;
  const rad = THREE.MathUtils.degToRad(def[2]);
  if (def[1] === 'x') group.rotation.x = rad;
  if (def[1] === 'z') group.rotation.z = rad;
}

// Steps 1 to 5 for one item. Returns a group with origin at the footprint centre, base at y = 0,
// true scale in metres.
async function prepareItem(p) {
  const model = await loadGlb(p);
  const stats = fixMaterials(model);

  const nativeBox = preciseBox(model);
  const nativeSize = [0, 1, 2].map((i) => nativeBox.max[i] - nativeBox.min[i]);
  const target = targetDims(p, priors);
  const choice = chooseOrientation(nativeSize, target.ratio, p.orient_override || null, target.used_prior);

  const oriented = new THREE.Group();
  oriented.name = 'oriented';
  oriented.add(model);
  applyOrientation(oriented, choice.name);

  const yawed = new THREE.Group();
  yawed.name = 'yaw';
  yawed.add(oriented);
  if (p.yaw_deg) yawed.rotation.y = THREE.MathUtils.degToRad(p.yaw_deg);

  // Step 4: re-pivot. Generated models often have their pivot far from the object.
  const box = preciseBox(yawed);
  const ps = pivotAndScale(box, target.height_in);
  const pivot = new THREE.Group();
  pivot.name = 'pivot';
  yawed.position.set(...ps.translate);
  pivot.add(yawed);

  // Step 5: uniform scale by height (metres).
  const root = new THREE.Group();
  root.name = 'item';
  pivot.scale.setScalar(ps.scale);
  root.add(pivot);

  // Generic fallback models only: stretch the footprint to the listing's W x D so the box the user
  // sees in AR is the real size even though the shape is generic.
  if (p.fit_box && p.w_in > 0 && p.d_in > 0) {
    const b = preciseBox(root);
    const mw = b.max[0] - b.min[0], md = b.max[2] - b.min[2];
    const big = Math.max(p.w_in, p.d_in) * IN_TO_M, small = Math.min(p.w_in, p.d_in) * IN_TO_M;
    const [tw, td] = mw >= md ? [big, small] : [small, big];
    root.scale.set(tw / mw, 1, td / md);
  }

  const finalBox = preciseBox(root);
  const final_in = {
    w: (finalBox.max[0] - finalBox.min[0]) / IN_TO_M,
    h: (finalBox.max[1] - finalBox.min[1]) / IN_TO_M,
    d: (finalBox.max[2] - finalBox.min[2]) / IN_TO_M,
  };
  return {
    root, stats, final_in,
    info: {
      orientation: choice.name, orientation_scores: choice.scores, overridden: choice.overridden,
      used_prior: target.used_prior, native_size: nativeSize,
      base_y_m: finalBox.min[1],
      center_xz_m: [(finalBox.min[0] + finalBox.max[0]) / 2, (finalBox.min[2] + finalBox.max[2]) / 2],
    },
  };
}

async function exportScene(scene, maxTexture) {
  scene.updateMatrixWorld(true);
  // Step 6
  const usdz = await new USDZExporter().parseAsync(scene, { quickLookCompatible: true, maxTextureSize: maxTexture });
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true, maxTextureSize: maxTexture });
  return { usdzB64: bufferToB64(usdz), glbB64: bufferToB64(glb), usdz_bytes: usdz.byteLength, glb_bytes: glb.byteLength };
}

window.exportItem = async (p) => {
  const item = await prepareItem(p);
  const scene = new THREE.Scene();
  scene.add(item.root);
  const out = await exportScene(scene, p.max_texture || 1024);
  return { ...out, final_in: item.final_in, stats: item.stats, ...item.info };
};

// Corner sets (stretch): several ready items composed into one file. AR Quick Look shows one
// file per session, so the set must be a single USDZ.
window.exportSet = async (p) => {
  const scene = new THREE.Scene();
  const items = [];
  for (const it of p.items) {
    const { yaw_deg: placeYaw, ...rest } = it;
    const item = await prepareItem({ ...rest, yaw_deg: it.model_yaw_deg || 0 });
    const holder = new THREE.Group();
    holder.name = `set_item_${items.length}`;
    holder.add(item.root);
    holder.position.set((it.x_in || 0) * IN_TO_M, (it.y_in || 0) * IN_TO_M, (it.z_in || 0) * IN_TO_M);
    if (placeYaw) holder.rotation.y = THREE.MathUtils.degToRad(placeYaw);
    scene.add(holder);
    items.push({ final_in: item.final_in, stats: item.stats, ...item.info });
  }
  const box = preciseBox(scene);
  const out = await exportScene(scene, p.max_texture || 1024);
  return {
    ...out, items,
    final_in: {
      w: (box.max[0] - box.min[0]) / IN_TO_M, h: (box.max[1] - box.min[1]) / IN_TO_M, d: (box.max[2] - box.min[2]) / IN_TO_M,
    },
    base_y_m: box.min[1],
  };
};

// PNG preview of a processed GLB (three-quarter view), for human checks during demo curation.
window.renderPng = async ({ glbB64, size = 512 }) => {
  const model = await loadGlb({ glbB64 });
  const box = new THREE.Box3().setFromObject(model, true);
  const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
  const r = Math.max(sz.x, sz.y, sz.z) || 1;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf2f0ec);
  scene.add(model, new THREE.HemisphereLight(0xffffff, 0x8a8478, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  const grid = new THREE.GridHelper(r * 3, 12, 0xb0aca4, 0xd8d4cc);
  grid.position.set(c.x, box.min.y, c.z);
  scene.add(grid);
  const cam = new THREE.PerspectiveCamera(35, 1, r / 100, r * 20);
  cam.position.set(c.x + r * 1.5, c.y + r * 0.9, c.z + r * 1.9);
  cam.lookAt(c);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(size, size);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL('image/png');
  renderer.dispose();
  return url.split(',')[1];
};

window.exporterReady = true;
