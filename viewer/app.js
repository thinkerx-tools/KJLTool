import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const FALLBACK_COLORS = [
  0xc4a574, 0xb08968, 0xd4b896, 0x8d6e63, 0xa1887f, 0xcfc0a8, 0x9e7e5e,
];

const SCENE_BATCH_SIZE = 24;
const TREE_COLLAPSE_THRESHOLD = 80;

let sharedHoleLineMat = null;
let sharedSlotEdgeMat = null;

const state = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  rootGroup: null,
  slotGroup: null,
  boards: [],
  boardMeshes: new Map(),
  pickables: [],
  selectedId: null,
  selectedIds: new Set(),
  selectedNodeKey: null,
  hiddenIds: new Set(),
  searchIndex: [],
  searchMatches: [],
  searchMatchIds: new Set(),
  searchMarkerGroup: null,
  descendantMeshIds: new Map(),
  nodeParentKey: new Map(),
  nodeByMeshId: new Map(),
  nodeByTreeKey: new Map(),
  treeExpanded: new Set(),
  treeRoots: [],
  treeCutters: [],
  performanceMode: false,
  highlightPrev: { selectedIds: new Set(), searchIds: new Set() },
  renderLoopId: null,
  renderStopTimer: null,
  renderLoopActive: false,
  textures: new Map(),
  materialCache: new Map(),
  slotMaterial: null,
};

const el = {
  meta: document.getElementById('meta'),
  status: document.getElementById('status'),
  tree: document.getElementById('tree'),
  fileInput: document.getElementById('fileInput'),
  fitBtn: document.getElementById('fitBtn'),
  showAllBtn: document.getElementById('showAllBtn'),
  searchInput: document.getElementById('searchInput'),
  searchClearBtn: document.getElementById('searchClearBtn'),
  searchResults: document.getElementById('searchResults'),
  showHoles: document.getElementById('showHoles'),
  showSlots: document.getElementById('showSlots'),
  viewport: document.getElementById('viewport'),
  dropHint: document.getElementById('drop-hint'),
  inspectorBody: document.getElementById('inspectorBody'),
  inspectorCloseBtn: document.getElementById('inspectorCloseBtn'),
};

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}

function requestRender() {
  if (!state.renderer || !state.scene || !state.camera) return;
  if (state.renderLoopActive) return;
  if (state.renderLoopId != null) return;
  state.renderLoopId = requestAnimationFrame(() => {
    state.renderLoopId = null;
    state.controls?.update();
    state.renderer.render(state.scene, state.camera);
  });
}

function startInteractiveRender() {
  clearTimeout(state.renderStopTimer);
  if (state.renderLoopActive) return;
  state.renderLoopActive = true;

  const loop = () => {
    if (!state.renderLoopActive) {
      state.renderLoopId = null;
      return;
    }
    state.renderLoopId = requestAnimationFrame(loop);
    state.controls.update();
    state.renderer.render(state.scene, state.camera);
  };
  loop();
}

function stopInteractiveRender(delay = 120) {
  clearTimeout(state.renderStopTimer);
  state.renderStopTimer = setTimeout(() => {
    state.renderLoopActive = false;
    requestRender();
  }, delay);
}

function getHoleLineMaterial() {
  if (!sharedHoleLineMat) {
    sharedHoleLineMat = new THREE.LineBasicMaterial({ color: 0xff8a4c });
  }
  return sharedHoleLineMat;
}

function getSlotEdgeMaterial() {
  if (!sharedSlotEdgeMat) {
    sharedSlotEdgeMat = new THREE.LineBasicMaterial({
      color: 0xffb703,
      transparent: true,
      opacity: 0.95,
    });
  }
  return sharedSlotEdgeMat;
}

function rebuildPickables() {
  const pickables = [];
  for (const group of state.boardMeshes.values()) {
    if (!group.visible) continue;
    const mesh = group.children.find((c) => c.isMesh);
    if (mesh) pickables.push(mesh);
  }
  state.pickables = pickables;
}

function isBoard(node) {
  return node && (node.modelTypeId === 3 || String(node['@type']) === '8');
}

function collectBoards(node, rootName, out) {
  if (!node || node.deleted || node.ignore) return;
  if (isBoard(node)) {
    out.push({ node, rootName });
  }
  const children = node.subModels || [];
  for (const child of children) {
    collectBoards(child, rootName, out);
  }
}

function collectFromDesign(data) {
  const roots = data.paramModel || [];
  const boards = [];
  for (const root of roots) {
    const rootName = root.modelName || '未命名模型';
    collectBoards(root, rootName, boards);
  }
  return { roots, boards };
}

/** Collect cutter boards from boolInterferenceModels (used to carve slots). */
function collectBoolCutters(data) {
  const hosts = [];
  const walkAll = (node) => {
    if (!node) return;
    hosts.push(node);
    for (const c of node.subModels || []) walkAll(c);
  };
  for (const root of data.paramModel || []) walkAll(root);

  const candidates = [];

  for (const host of hosts) {
    for (const item of host.boolInterferenceModels || []) {
      const boolModel = item?.boolModel;
      if (!boolModel) continue;

      const walkLeaves = (n) => {
        if (!n || n.deleted || n.ignore) return;
        if (isBoard(n)) {
          const abb = n.absBoundingBox;
          const abbKey = abb
            ? [
                abb.min.x, abb.min.y, abb.min.z,
                abb.max.x, abb.max.y, abb.max.z,
              ].map((v) => Number(v).toFixed(1)).join(',')
            : n.id;
          candidates.push({
            node: n,
            boolModel,
            hostName: host.modelName || '未知',
            hostId: host.id,
            boolOperation: item.boolOperation,
            append: !!item.append,
            passUp: !!item.passUp,
            boolModelName: boolModel.modelName || '开槽体',
            boolModelId: boolModel.id,
            abbKey,
            id: `slot-${n.id || boolModel.id || candidates.length}`,
          });
        }
        for (const c of n.subModels || []) walkLeaves(c);
      };
      walkLeaves(boolModel);
    }
  }

  // Same absBB may appear on host (append) and child (passUp) — keep one.
  // Prefer append=true / passUp=false as the primary definition.
  const bestByAbb = new Map();
  for (const c of candidates) {
    const prev = bestByAbb.get(c.abbKey);
    if (!prev) {
      bestByAbb.set(c.abbKey, c);
      continue;
    }
    const score = (x) => (x.append ? 2 : 0) + (x.passUp ? 0 : 1);
    if (score(c) > score(prev)) bestByAbb.set(c.abbKey, c);
  }

  return [...bestByAbb.values()];
}

function getSlotMaterial() {
  if (state.slotMaterial) return state.slotMaterial;
  state.slotMaterial = new THREE.MeshLambertMaterial({
    color: 0x2ec4b6,
    emissive: 0x145c55,
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.7,
    side: THREE.FrontSide,
    depthWrite: true,
  });
  return state.slotMaterial;
}

/**
 * Bool cutter: triangular prism from points+thickness.
 * Pivot is the solid center (中心点对齐), placed at absBoundingBox center.
 */
function addBoolCutterMesh(cutter, material, parent) {
  const leaf = cutter.node;
  const pts = leaf.points || leaf.paramPlankPath?.path?.resultPoints;
  if (!pts || pts.length < 3) return null;

  const thickness = leaf.thickness || leaf.size?.z;
  if (!thickness) return null;

  const shape = new THREE.Shape();
  shape.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 1,
  });
  // Center the whole solid on its AABB center (not path bottom-left / thickness edge).
  geometry.computeBoundingBox();
  const c = new THREE.Vector3();
  geometry.boundingBox.getCenter(c);
  geometry.translate(-c.x, -c.y, -c.z);

  const mesh = new THREE.Mesh(geometry, material);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 20),
    getSlotEdgeMaterial(),
  );
  edges.name = 'slotEdges';

  const boardGroup = new THREE.Group();
  boardGroup.add(mesh);
  boardGroup.add(edges);
  boardGroup.userData = {
    id: cutter.id,
    name: cutter.boolModelName || leaf.modelName || '开槽体',
    rootName: '布尔开槽',
    kind: 'slot',
    hostName: cutter.hostName,
    boolModelName: cutter.boolModelName,
  };

  const abb = leaf.absBoundingBox;
  const centerPos = abb
    ? {
        x: (abb.min.x + abb.max.x) / 2,
        y: (abb.min.y + abb.max.y) / 2,
        z: (abb.min.z + abb.max.z) / 2,
      }
    : leaf.absPosition;

  applyKjlTransform(boardGroup, centerPos, leaf.absRotation);

  parent.add(boardGroup);
  state.boardMeshes.set(cutter.id, boardGroup);
  registerNodeLookup(leaf, cutter.id, {
    rootName: '布尔开槽',
    hostName: cutter.hostName,
    boolModelName: cutter.boolModelName,
    kind: 'slot',
  });
  return boardGroup;
}

/** Arc center from chord endpoints + radius + flags */
function arcCenter(p0, p1, radius, clockwise, minorArc) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-8 || radius <= 0) return null;

  const half = dist / 2;
  let r = radius;
  if (r < half - 1e-6) {
    r = half; // clamp degenerate
  }

  const h = Math.sqrt(Math.max(0, r * r - half * half));
  const mx = (p0.x + p1.x) / 2;
  const my = (p0.y + p1.y) / 2;
  const nx = -dy / dist;
  const ny = dx / dist;

  // Two possible centers
  const c1 = { x: mx + nx * h, y: my + ny * h };
  const c2 = { x: mx - nx * h, y: my - ny * h };

  const pick = (c) => {
    const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
    const a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
    let delta = a1 - a0;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    // Path direction in KJL plane: clockwise means negative delta in standard math angles
    const isCw = delta < 0;
    if (clockwise !== isCw) {
      if (delta > 0) delta -= Math.PI * 2;
      else delta += Math.PI * 2;
    }

    const abs = Math.abs(delta);
    const isMinor = abs <= Math.PI + 1e-6;
    return { center: c, a0, delta, score: (minorArc === isMinor ? 0 : 10) + Math.abs(abs - (minorArc ? Math.min(abs, Math.PI * 2 - abs) : abs)) };
  };

  const o1 = pick(c1);
  const o2 = pick(c2);
  return o1.score <= o2.score ? o1 : o2;
}

function sampleArc(p0, p1, line, out) {
  const radius = line.radius;
  if (!radius || radius <= 0) {
    out.push({ x: p1.x, y: p1.y });
    return;
  }
  const info = arcCenter(p0, p1, radius, !!line.clockwise, line.minorArc !== false);
  if (!info) {
    out.push({ x: p1.x, y: p1.y });
    return;
  }
  const { center, a0, delta } = info;
  const steps = Math.max(8, Math.ceil(Math.abs(delta) / (Math.PI / 18)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const a = a0 + delta * t;
    out.push({
      x: center.x + Math.cos(a) * radius,
      y: center.y + Math.sin(a) * radius,
    });
  }
}

/** Build sampled 2D ring from resultPoints + resultLines */
function buildRingFromResult(resultPoints, resultLines) {
  if (!resultPoints || resultPoints.length < 2) return null;
  const n = resultPoints.length;
  const lines = resultLines || [];
  const ring = [{ x: resultPoints[0].x, y: resultPoints[0].y }];

  for (let i = 0; i < n; i++) {
    const p0 = resultPoints[i];
    const p1 = resultPoints[(i + 1) % n];
    const line = lines[i] || { type: 0 };
    if (line.type === 1) {
      sampleArc(p0, p1, line, ring);
    } else {
      ring.push({ x: p1.x, y: p1.y });
    }
  }

  // drop duplicate closing point if present
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-4) {
    ring.pop();
  }
  return ring.length >= 3 ? ring : null;
}

function buildRingFromPoints(points) {
  if (!points || points.length < 3) return null;
  return points.map((p) => ({ x: p.x, y: p.y }));
}

function pathToRing(pathObj) {
  if (!pathObj) return null;
  const fromResult = buildRingFromResult(pathObj.resultPoints, pathObj.resultLines);
  if (fromResult) return fromResult;
  if (pathObj.paramPoints && pathObj.paramPoints.length >= 3) {
    return pathObj.paramPoints.map((p) => ({
      x: p.position.x,
      y: p.position.y,
    }));
  }
  return null;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function ensureWinding(ring, wantCCW) {
  const area = ringArea(ring);
  const isCCW = area > 0;
  if (wantCCW !== isCCW) return ring.slice().reverse();
  return ring;
}

function ringToShapePath(ring) {
  const path = new THREE.Path();
  path.moveTo(ring[0].x, ring[0].y);
  for (let i = 1; i < ring.length; i++) {
    path.lineTo(ring[i].x, ring[i].y);
  }
  path.closePath();
  return path;
}

function buildBoardShape(boardNode) {
  const ppp = boardNode.paramPlankPath || {};
  let outer = pathToRing(ppp.path);
  if (!outer) {
    outer = buildRingFromPoints(boardNode.points);
  }
  if (!outer) return null;

  outer = ensureWinding(outer, true);
  const shape = new THREE.Shape();
  shape.moveTo(outer[0].x, outer[0].y);
  for (let i = 1; i < outer.length; i++) {
    shape.lineTo(outer[i].x, outer[i].y);
  }
  shape.closePath();

  const holes = [];
  const holePaths = [...(ppp.holes || []), ...(ppp.slots || [])];
  for (const hole of holePaths) {
    let ring = pathToRing(hole);
    if (!ring || ring.length < 3) continue;
    ring = ensureWinding(ring, false); // holes typically opposite winding
    shape.holes.push(ringToShapePath(ring));
    holes.push(ring);
  }

  return { shape, outer, holes };
}

function applyKjlTransform(object3d, absPosition, absRotation) {
  const pos = absPosition || { x: 0, y: 0, z: 0 };
  const rot = absRotation || { x: 0, y: 0, z: 0 };

  // Kujiale/Unity-style Euler: ZXY (not Three default XYZ).
  const mK = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rot.x || 0, rot.y || 0, rot.z || 0, 'ZXY'),
  );
  mK.compose(
    new THREE.Vector3(pos.x || 0, pos.y || 0, pos.z || 0),
    q,
    new THREE.Vector3(1, 1, 1),
  );

  // Basis change: P_three = B * P_kjl, (x,y,z)_kjl -> (x,z,-y)_three
  const B = new THREE.Matrix4().set(
    1, 0, 0, 0,
    0, 0, 1, 0,
    0, -1, 0, 0,
    0, 0, 0, 1,
  );
  const mT = new THREE.Matrix4().multiplyMatrices(B, mK);
  object3d.matrixAutoUpdate = false;
  object3d.matrix.copy(mT);
  object3d.matrixWorldNeedsUpdate = true;
}

function getTextureMap(data) {
  const map = new Map();
  const list = data.resource?.textures || [];
  for (const t of list) {
    if (t.obsBrandGoodId) map.set(t.obsBrandGoodId, t);
  }
  return map;
}

function getMaterial(boardNode, index) {
  const key = boardNode.textureObsBrandGoodId || `fallback-${index % FALLBACK_COLORS.length}`;
  if (state.materialCache.has(key)) return state.materialCache.get(key);

  const color = FALLBACK_COLORS[index % FALLBACK_COLORS.length];
  const mat = new THREE.MeshLambertMaterial({
    color,
    side: THREE.FrontSide,
  });

  const texInfo = state.textures.get(boardNode.textureObsBrandGoodId);
  if (texInfo?.previewImg) {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      texInfo.previewImg,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        mat.map = tex;
        mat.color.set(0xffffff);
        mat.needsUpdate = true;
      },
      undefined,
      () => {
        /* keep fallback color */
      },
    );
  }

  state.materialCache.set(key, mat);
  return mat;
}

function createHoleOutlines(boardGroup, holes, thickness) {
  const positions = [];
  const half = thickness / 2;
  const pushSeg = (ax, ay, az, bx, by, bz) => {
    positions.push(ax, ay, az, bx, by, bz);
  };

  for (const ring of holes) {
    if (ring.length < 2) continue;
    const top = ring.map((p) => [p.x, p.y, half]);
    const bot = ring.map((p) => [p.x, p.y, -half]);
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      pushSeg(top[i][0], top[i][1], top[i][2], top[j][0], top[j][1], top[j][2]);
      pushSeg(bot[i][0], bot[i][1], bot[i][2], bot[j][0], bot[j][1], bot[j][2]);
    }
    const step = Math.max(1, Math.floor(ring.length / 6));
    for (let i = 0; i < ring.length; i += step) {
      pushSeg(ring[i].x, ring[i].y, -half, ring[i].x, ring[i].y, half);
    }
  }

  if (!positions.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(geometry, getHoleLineMaterial());
  lines.name = 'holeOutlines';
  boardGroup.add(lines);
  return lines;
}

function clearSceneContent() {
  if (state.rootGroup) {
    state.scene.remove(state.rootGroup);
    state.rootGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
    });
  }
  state.rootGroup = new THREE.Group();
  state.rootGroup.name = 'designRoot';
  state.slotGroup = new THREE.Group();
  state.slotGroup.name = 'boolSlots';
  state.rootGroup.add(state.slotGroup);
  state.scene.add(state.rootGroup);
  state.boardMeshes.clear();
  state.boards = [];
  state.selectedId = null;
  state.selectedIds.clear();
  state.selectedNodeKey = null;
  state.hiddenIds.clear();
  state.searchIndex = [];
  state.searchMatches = [];
  state.searchMatchIds.clear();
  clearSearchMarkers();
  state.descendantMeshIds.clear();
  state.nodeParentKey.clear();
  state.nodeByMeshId.clear();
  state.nodeByTreeKey.clear();
  state.treeExpanded.clear();
  state.treeRoots = [];
  state.treeCutters = [];
  state.pickables = [];
  state.highlightPrev = { selectedIds: new Set(), searchIds: new Set() };
  state.materialCache.clear();
  clearInspector();
}

function addPlankMesh(node, {
  id,
  rootName,
  material,
  parent,
  kind = 'board',
  extraUserData = {},
}) {
  const builtShape = buildBoardShape(node);
  if (!builtShape) return null;

  const thickness = node.thickness || node.size?.z || 18;
  const geometry = new THREE.ExtrudeGeometry(builtShape.shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: state.performanceMode ? 3 : 6,
  });
  // Extrude along +Z from 0..thickness; center thickness on local origin
  geometry.translate(0, 0, -thickness / 2);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.pickId = id;

  const boardGroup = new THREE.Group();
  boardGroup.add(mesh);
  boardGroup.userData = {
    id,
    name: node.modelName || (kind === 'slot' ? '开槽体' : '板件'),
    rootName,
    kind,
    holeCount: builtShape.holes.length,
    ...extraUserData,
  };

  applyKjlTransform(boardGroup, node.absPosition, node.absRotation);

  if (builtShape.holes.length) {
    const outlines = createHoleOutlines(boardGroup, builtShape.holes, thickness);
    if (outlines) outlines.visible = el.showHoles.checked;
  }

  parent.add(boardGroup);
  state.boardMeshes.set(id, boardGroup);
  registerNodeLookup(node, id, { rootName });
  return { boardGroup, holeCount: builtShape.holes.length };
}

async function buildSceneFromData(data, sourceLabel) {
  clearSceneContent();
  state.textures = getTextureMap(data);

  const { roots, boards } = collectFromDesign(data);
  const cutters = collectBoolCutters(data);
  state.boards = boards;
  state.treeRoots = roots;
  state.treeCutters = cutters;
  state.performanceMode = boards.length >= TREE_COLLAPSE_THRESHOLD;
  if (state.performanceMode && state.renderer) {
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  }

  let holeCount = 0;
  let built = 0;

  for (let i = 0; i < boards.length; i += SCENE_BATCH_SIZE) {
    const batch = boards.slice(i, i + SCENE_BATCH_SIZE);
    for (let j = 0; j < batch.length; j++) {
      const { node, rootName } = batch[j];
      const index = i + j;
      const id = node.id || node.modelInstanceId || `board-${index}`;
      const result = addPlankMesh(node, {
        id,
        rootName,
        material: getMaterial(node, index),
        parent: state.rootGroup,
        kind: 'board',
      });
      if (!result) continue;
      holeCount += result.holeCount;
      built += 1;
    }
    if (i + SCENE_BATCH_SIZE < boards.length) {
      setStatus(`正在构建场景 ${Math.min(i + SCENE_BATCH_SIZE, boards.length)}/${boards.length}…`);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  let slotCount = 0;
  const slotMat = getSlotMaterial();
  state.slotGroup.visible = el.showSlots.checked;

  cutters.forEach((cutter) => {
    const result = addBoolCutterMesh(cutter, slotMat, state.slotGroup);
    if (!result) return;
    slotCount += 1;
    const mesh = result.children.find((c) => c.isMesh);
    if (mesh) mesh.userData.pickId = cutter.id;
  });

  buildDescendantMeshIdCache(roots, cutters);
  initTreeExpanded(roots, cutters);
  rebuildPickables();

  const designName = data.designData?.designName || '未命名方案';
  const perfHint = state.performanceMode ? '　<span style="color:#9aa0a6">性能模式</span>' : '';
  el.meta.innerHTML = [
    `<div><strong>${escapeHtml(designName)}</strong></div>`,
    `<div>来源：${escapeHtml(sourceLabel)}</div>`,
    `<div>根模型：${roots.length}　板件：${built}　孔：${holeCount}　布尔槽：${slotCount}${perfHint}</div>`,
  ].join('');

  renderTree(roots, boards, cutters);
  state.searchIndex = buildSearchIndex(roots, cutters);
  clearSearch({ keepInput: false });
  fitCameraToScene();
  requestRender();
  setStatus(`已加载 ${built} 块板件，孔 ${holeCount}，布尔开槽 ${slotCount}`);
}

function nodeKey(node) {
  return String(node?.id || node?.modelInstanceId || '');
}

function treeNodeKey(node, fallback = '') {
  const key = nodeKey(node);
  return key || fallback;
}

function buildDescendantMeshIdCache(roots, cutters = []) {
  state.descendantMeshIds.clear();
  state.nodeParentKey.clear();

  const collectForNode = (node, parentKey = '') => {
    if (!node || node.deleted || node.ignore) return [];
    const key = treeNodeKey(node, `${parentKey}/${nodePrimaryName(node)}`);
    if (parentKey) state.nodeParentKey.set(key, parentKey);

    const ids = [];
    const selfId = node.id || node.modelInstanceId;
    if (selfId && state.boardMeshes.has(String(selfId))) ids.push(String(selfId));
    for (const child of node.subModels || []) {
      ids.push(...collectForNode(child, key));
    }
    state.descendantMeshIds.set(key, [...new Set(ids)]);
    return state.descendantMeshIds.get(key);
  };

  for (const root of roots) collectForNode(root);
  for (const cutter of cutters) {
    const key = treeNodeKey(cutter.node, cutter.id);
    const ids = state.boardMeshes.has(cutter.id) ? [cutter.id] : [];
    state.descendantMeshIds.set(key, ids);
    state.nodeParentKey.set(key, '布尔开槽');
  }
  state.descendantMeshIds.set('布尔开槽', cutters.map((c) => c.id).filter((id) => state.boardMeshes.has(id)));
}

function initTreeExpanded(roots, cutters = []) {
  state.treeExpanded.clear();
  for (const root of roots) {
    state.treeExpanded.add(treeNodeKey(root, nodePrimaryName(root)));
  }
  if (!state.performanceMode && cutters.length) {
    state.treeExpanded.add('布尔开槽');
  }
  if (state.performanceMode) return;
  const expandDepth = (node, depth, parentKey = '') => {
    if (!node || node.deleted || node.ignore) return;
    const key = treeNodeKey(node, `${parentKey}/${nodePrimaryName(node)}`);
    if (depth < 2) state.treeExpanded.add(key);
    for (const child of node.subModels || []) expandDepth(child, depth + 1, key);
  };
  for (const root of roots) expandDepth(root, 0);
}

function meshIdsUnder(node, fallback = '') {
  const key = treeNodeKey(node, fallback);
  return state.descendantMeshIds.get(key) || [];
}

function expandTreePathToKey(key) {
  if (!key) return;
  let current = key;
  const guard = new Set();
  while (current && !guard.has(current)) {
    guard.add(current);
    state.treeExpanded.add(current);
    current = state.nodeParentKey.get(current);
  }
}

function expandTreeForMatches(matches) {
  for (const item of matches) {
    expandTreePathToKey(item.key);
  }
}

function toggleTreeNode(key) {
  if (!key) return;
  if (state.treeExpanded.has(key)) state.treeExpanded.delete(key);
  else state.treeExpanded.add(key);
  renderTree(state.treeRoots, state.boards, state.treeCutters);
}

function nodeSearchFields(node, extra = {}) {
  return [
    node?.modelName,
    node?.originalModelName,
    node?.modelBrandGoodName,
    node?.textureName,
    node?.customCode,
    node?.modelNumber,
    node?.id,
    node?.modelInstanceId,
    extra.rootName,
    extra.hostName,
    extra.boolModelName,
  ].filter(Boolean).map(String);
}

function buildSearchIndex(roots, cutters = []) {
  const items = [];
  const seen = new Set();

  const pushItem = (node, extra = {}) => {
    if (!node || node.deleted || node.ignore) return;
    const key = nodeKey(node) || `${nodePrimaryName(node)}-${items.length}`;
    if (seen.has(key)) return;
    seen.add(key);

    const meshIds = [...new Set(meshIdsUnder(node, nodePrimaryName(node)))];
    const label = nodePrimaryName(node);
    const meta = [
      extra.rootName && extra.rootName !== label ? extra.rootName : null,
      extra.hostName ? `宿主:${extra.hostName}` : null,
      extra.boolModelName && extra.boolModelName !== label ? extra.boolModelName : null,
      nodeNameMeta(node),
    ].filter(Boolean).join(' · ');

    items.push({
      key,
      node,
      meshIds,
      label,
      meta,
      searchText: nodeSearchFields(node, extra).join(' ').toLowerCase(),
    });

    const treeKey = treeNodeKey(node, nodePrimaryName(node));
    if (!state.nodeByTreeKey.has(treeKey)) {
      registerNodeLookup(node, meshIds[0] || '', extra);
    }
  };

  const walk = (node, ctx) => {
    if (!node || node.deleted || node.ignore) return;
    pushItem(node, ctx);
    for (const child of node.subModels || []) walk(child, ctx);
  };

  for (const root of roots) {
    const rootName = nodePrimaryName(root);
    walk(root, { rootName });
  }

  for (const cutter of cutters) {
    pushItem(cutter.node, {
      rootName: '布尔开槽',
      hostName: cutter.hostName,
      boolModelName: cutter.boolModelName,
    });
    const last = items[items.length - 1];
    if (last && state.boardMeshes.has(cutter.id)) {
      last.meshIds = [...new Set([...last.meshIds, cutter.id])];
    }
  }

  return items;
}

function matchSearchItem(item, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return false;
  return terms.every((term) => item.searchText.includes(term));
}

function ensureSearchMarkerGroup() {
  if (!state.searchMarkerGroup) {
    state.searchMarkerGroup = new THREE.Group();
    state.searchMarkerGroup.name = 'searchMarkers';
    state.scene.add(state.searchMarkerGroup);
  }
  return state.searchMarkerGroup;
}

function clearSearchMarkers() {
  if (!state.searchMarkerGroup) return;
  while (state.searchMarkerGroup.children.length) {
    const child = state.searchMarkerGroup.children[0];
    state.searchMarkerGroup.remove(child);
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  }
}

function updateSearchMarkers(meshIds) {
  ensureSearchMarkerGroup();
  clearSearchMarkers();
  for (const id of meshIds) {
    const group = state.boardMeshes.get(id);
    if (!group || !group.visible) continue;
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) continue;
    const helper = new THREE.Box3Helper(box, 0xff6b35);
    state.searchMarkerGroup.add(helper);
  }
  requestRender();
}

function applyMeshHighlights() {
  const selectedIds = state.selectedIds;
  const searchIds = state.searchMatchIds;
  const prev = state.highlightPrev;
  const affected = new Set();

  for (const id of prev.selectedIds) {
    if (!selectedIds.has(id)) affected.add(id);
  }
  for (const id of selectedIds) {
    if (!prev.selectedIds.has(id)) affected.add(id);
  }
  for (const id of prev.searchIds) {
    if (!searchIds.has(id)) affected.add(id);
  }
  for (const id of searchIds) {
    if (!prev.searchIds.has(id)) affected.add(id);
  }

  const sameSelection =
    prev.selectedIds.size === selectedIds.size &&
    [...prev.selectedIds].every((id) => selectedIds.has(id));
  if (!affected.size && sameSelection && prev.searchIds.size === searchIds.size) {
    return;
  }

  const updateOne = (bid) => {
    const group = state.boardMeshes.get(bid);
    if (!group) return;
    const mesh = group.children.find((c) => c.isMesh);
    if (!mesh) return;
    if (!mesh.userData._baseMat) mesh.userData._baseMat = mesh.material;

    if (selectedIds.has(bid)) {
      if (!mesh.userData._hlMat) {
        const hl = mesh.userData._baseMat.clone();
        hl.emissive = new THREE.Color(0x665500);
        hl.emissiveIntensity = 0.55;
        mesh.userData._hlMat = hl;
      }
      mesh.material = mesh.userData._hlMat;
    } else if (searchIds.has(bid)) {
      if (!mesh.userData._searchMat) {
        const searchMat = mesh.userData._baseMat.clone();
        searchMat.emissive = new THREE.Color(0x8a3d12);
        searchMat.emissiveIntensity = 0.42;
        mesh.userData._searchMat = searchMat;
      }
      mesh.material = mesh.userData._searchMat;
    } else {
      mesh.material = mesh.userData._baseMat;
    }
  };

  if (!prev.selectedIds.size && !prev.searchIds.size && !selectedIds.size && !searchIds.size) {
    for (const bid of state.boardMeshes.keys()) updateOne(bid);
  } else if (affected.size > state.boardMeshes.size * 0.6) {
    for (const bid of state.boardMeshes.keys()) updateOne(bid);
  } else {
    for (const bid of affected) updateOne(bid);
  }

  prev.selectedIds = new Set(selectedIds);
  prev.searchIds = new Set(searchIds);
  requestRender();
}

function focusCameraOnMeshIds(ids, { minDist = 400 } = {}) {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  if (!idSet.size) return false;

  const box = new THREE.Box3();
  for (const id of idSet) {
    const group = state.boardMeshes.get(id);
    if (!group || !group.visible) continue;
    box.expandByObject(group);
  }
  if (box.isEmpty()) return false;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const dist = Math.max(size.length() * 1.25, minDist);
  const dir = state.camera.position.clone().sub(state.controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(1, 0.8, 1);
  dir.normalize().multiplyScalar(dist);
  state.camera.position.copy(center).add(dir);
  state.controls.target.copy(center);
  state.controls.update();
  requestRender();
  return true;
}

function syncSearchTreeUi(matches = state.searchMatches) {
  const matchedKeys = new Set(matches.map((item) => item.key));
  el.tree.querySelectorAll('[data-node-key]').forEach((row) => {
    row.classList.toggle('search-match', matchedKeys.has(row.dataset.nodeKey));
  });
  const first = el.tree.querySelector('.search-match');
  if (first) first.scrollIntoView({ block: 'nearest' });
}

function renderSearchResults(matches) {
  if (!matches.length) {
    el.searchResults.classList.add('hidden');
    el.searchResults.innerHTML = '';
    return;
  }

  const meshCount = new Set(matches.flatMap((item) => item.meshIds)).size;
  const parts = [
    `<div class="search-results-header">匹配 ${matches.length} 项，${meshCount} 个对象</div>`,
  ];
  matches.slice(0, 80).forEach((item, index) => {
    const meshHint = item.meshIds.length ? `${item.meshIds.length} 个对象` : '无 mesh';
    parts.push(
      `<div class="search-result-item" data-search-index="${index}">` +
        `<div class="name">${escapeHtml(item.label)}</div>` +
        `<div class="sub">${escapeHtml(item.meta || meshHint)}</div>` +
      `</div>`,
    );
  });
  if (matches.length > 80) {
    parts.push(`<div class="search-results-header">另有 ${matches.length - 80} 项未列出</div>`);
  }
  el.searchResults.innerHTML = parts.join('');
  el.searchResults.classList.remove('hidden');
}

function runSearch(query) {
  const q = query.trim();
  if (!q) {
    clearSearch({ keepInput: false });
    return;
  }

  const matches = state.searchIndex.filter((item) => matchSearchItem(item, q));
  const meshIds = new Set();
  for (const item of matches) {
    for (const id of item.meshIds) meshIds.add(id);
  }

  state.searchMatches = matches;
  state.searchMatchIds = meshIds;
  if (matches.length) {
    expandTreeForMatches(matches);
    renderTree(state.treeRoots, state.boards, state.treeCutters);
  }
  applyMeshHighlights();
  updateSearchMarkers(meshIds);
  syncSearchTreeUi(matches);
  renderSearchResults(matches);

  if (meshIds.size) {
    focusCameraOnMeshIds(meshIds);
    setStatus(`搜索「${q}」：${matches.length} 项，已高亮 ${meshIds.size} 个对象`);
  } else if (matches.length) {
    setStatus(`搜索「${q}」：${matches.length} 项（无可渲染对象，已在列表标出）`);
  } else {
    setStatus(`搜索「${q}」：未找到匹配节点`);
  }
}

function focusSearchMatch(index) {
  const item = state.searchMatches[index];
  if (!item) return;

  el.searchResults.querySelectorAll('.search-result-item').forEach((row, i) => {
    row.classList.toggle('active', i === index);
  });

  expandTreePathToKey(item.key);
  renderTree(state.treeRoots, state.boards, state.treeCutters);
  syncSearchTreeUi([item]);

  if (item.meshIds.length) {
    const meshIds = new Set(item.meshIds);
    state.searchMatchIds = meshIds;
    applyMeshHighlights();
    updateSearchMarkers(meshIds);
    focusCameraOnMeshIds(meshIds, { minDist: 300 });
    if (item.meshIds[0]) {
      setSelectedIds([item.meshIds[0]], { primaryId: item.meshIds[0] });
      applyMeshHighlights();
      syncTreeSelectionUi();
    }
  } else if (item.node?.absBoundingBox) {
    const bb = item.node.absBoundingBox;
    const raw = [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].join(',');
    focusBBoxString(raw);
  }

  if (item.meshIds.length > 1) {
    showCompareInspector(item.meshIds.filter((id) => state.boardMeshes.has(id)));
  } else if (item.key && findNodeEntryByTreeKey(item.key)) {
    showNodeInfoByTreeKey(item.key);
  } else if (item.meshIds[0]) {
    showNodeInfoByMeshId(item.meshIds[0]);
  } else {
    showNodeInfo({ node: item.node, meshId: '', extra: {} });
  }
}

function clearSearch({ keepInput = false } = {}) {
  state.searchMatches = [];
  state.searchMatchIds.clear();
  if (!keepInput) el.searchInput.value = '';
  applyMeshHighlights();
  clearSearchMarkers();
  syncSearchTreeUi([]);
  renderSearchResults([]);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function roundNum(n) {
  if (n == null || Number.isNaN(Number(n))) return '-';
  const v = Number(n);
  return Math.abs(v - Math.round(v)) < 1e-3 ? String(Math.round(v)) : v.toFixed(1);
}

function nodePrimaryName(node) {
  return node?.modelName || node?.originalModelName || node?.modelBrandGoodName || '未命名';
}

function nodeNameMeta(node) {
  const bits = [];
  if (node.originalModelName && node.originalModelName !== node.modelName) {
    bits.push(node.originalModelName);
  }
  if (node.modelBrandGoodName && node.modelBrandGoodName !== node.modelName) {
    bits.push(node.modelBrandGoodName);
  }
  if (node.textureName) bits.push(node.textureName);
  if (node.customCode) bits.push(`编码:${node.customCode}`);
  if (node.modelNumber) bits.push(`型号:${node.modelNumber}`);
  const size = node.size || node.boxSize;
  if (size) {
    bits.push(`${roundNum(size.x)}×${roundNum(size.y)}×${roundNum(size.z)}`);
  }
  const holes = (node.paramPlankPath?.holes?.length || 0) + (node.paramPlankPath?.slots?.length || 0);
  if (holes) bits.push(`孔${holes}`);
  const bools = node.boolInterferenceModels?.length || 0;
  if (bools) bits.push(`布尔${bools}`);
  return bits.join(' · ');
}

function nodeTypeTag(node) {
  if (isBoard(node)) return '板件';
  if (node.modelTypeId === 2) return '五金';
  if (node.boolInterferenceModels?.length) return '含槽';
  return '组件';
}

function formatVec3(v) {
  if (!v || typeof v !== 'object') return '-';
  return `${roundNum(v.x)} × ${roundNum(v.y)} × ${roundNum(v.z)}`;
}

function formatDeg(v) {
  if (!v || typeof v !== 'object') return '-';
  return `${roundNum(v.x)}° / ${roundNum(v.y)}° / ${roundNum(v.z)}°`;
}

function registerNodeLookup(node, meshId = '', extra = {}) {
  if (!node) return;
  const key = treeNodeKey(node, meshId || nodePrimaryName(node));
  const entry = { node, meshId: meshId ? String(meshId) : '', extra };
  if (key) state.nodeByTreeKey.set(key, entry);
  if (meshId) state.nodeByMeshId.set(String(meshId), entry);
}

function findNodeEntryByMeshId(id) {
  if (!id) return null;
  return state.nodeByMeshId.get(String(id)) || null;
}

function findNodeEntryByTreeKey(key) {
  if (!key) return null;
  return state.nodeByTreeKey.get(key) || null;
}

function inspectorRow(label, value) {
  if (value == null || value === '' || value === '-') return '';
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(String(value))}</td></tr>`;
}

function paramDisplayLabel(param) {
  if (!param || typeof param !== 'object') return '';
  const title = param.displayName || param.simpleName || param.name || '';
  const code = param.name && param.displayName && param.name !== param.displayName
    ? param.name
    : (param.simpleName && param.displayName && param.simpleName !== param.displayName ? param.simpleName : '');
  if (title && code) return `${title} (${code})`;
  return title || code || '参数';
}

function paramDisplayValue(param) {
  if (!param || typeof param !== 'object') return '';
  const raw = param.value;
  if (raw == null || raw === '') return '';

  const options = param.optionValues || param.options || [];
  if (Array.isArray(options) && options.length) {
    const hit = options.find((o) => o && String(o.value) === String(raw));
    if (hit?.name && hit.name !== String(raw)) return `${hit.name} (${raw})`;
    if (hit?.name) return String(hit.name);
  }

  if (param.formulaDisplayName && param.formulaDisplayName !== '默认') {
    return `${raw}  ← ${param.formulaDisplayName}`;
  }
  return String(raw);
}

function renderParamRows(params) {
  if (!Array.isArray(params) || !params.length) return '';
  return params
    .filter((p) => p && typeof p === 'object')
    .map((p) => {
      const label = paramDisplayLabel(p);
      const value = paramDisplayValue(p);
      return (
        `<tr><th>${escapeHtml(label)}</th>` +
        `<td>${escapeHtml(value || '(空)')}</td></tr>`
      );
    })
    .join('');
}

function clearInspector() {
  state.selectedNodeKey = null;
  if (!el.inspectorBody) return;
  el.inspectorBody.innerHTML = '<div class="inspector-empty">选中左侧树或场景中的节点以查看详情<br/>按住 Ctrl 可多选板件对比属性</div>';
}

function collectCompareProps(entry) {
  const { node, meshId = '', extra = {} } = entry;
  const name = nodePrimaryName(node);
  const kind = extra.kind === 'slot' ? '开槽' : nodeTypeTag(node);
  const size = node.size || node.boxSize || node.customSize;
  const thickness = node.thickness ?? size?.z;
  const holes = node.paramPlankPath?.holes?.length || 0;
  const slots = node.paramPlankPath?.slots?.length || 0;
  const bools = node.boolInterferenceModels?.length || 0;
  const childCount = (node.subModels || []).filter((c) => c && !c.deleted && !c.ignore).length;

  const props = [
    ['名称', name || ''],
    ['原始名', node.originalModelName && node.originalModelName !== name ? node.originalModelName : ''],
    ['商品名', node.modelBrandGoodName && node.modelBrandGoodName !== name ? node.modelBrandGoodName : ''],
    ['类型', kind],
    ['ID', node.id ? String(node.id) : ''],
    ['实例 ID', node.modelInstanceId ? String(node.modelInstanceId) : ''],
    ['Mesh ID', meshId ? String(meshId) : ''],
    ['编码', node.customCode || ''],
    ['型号', node.modelNumber || node.modelBrandGoodCode || ''],
    ['材质', node.textureName || ''],
    ['材质编号', node.textureProductNumber || ''],
    ['尺寸 (XYZ)', size ? formatVec3(size) : ''],
    ['厚度', thickness != null ? String(roundNum(thickness)) : ''],
    ['相对位置', node.position ? formatVec3(node.position) : ''],
    ['绝对位置', node.absPosition ? formatVec3(node.absPosition) : ''],
    ['旋转(度)', node.absRotationDegree ? formatDeg(node.absRotationDegree)
      : (node.rotateDegree ? formatDeg(node.rotateDegree) : '')],
    ['根模型', extra.rootName || ''],
    ['宿主', extra.hostName || ''],
    ['布尔模型', extra.boolModelName || ''],
    ['子节点', childCount ? String(childCount) : ''],
    ['孔位', holes ? String(holes) : ''],
    ['开槽路径', slots ? String(slots) : ''],
    ['布尔干涉', bools ? String(bools) : ''],
  ];

  for (const p of node.parameters || []) {
    if (!p || typeof p !== 'object') continue;
    const label = paramDisplayLabel(p);
    if (!label) continue;
    props.push([`参数 · ${label}`, paramDisplayValue(p) || '(空)']);
  }
  return props;
}

function showCompareInspector(ids) {
  if (!el.inspectorBody) return;
  const entries = ids
    .map((id) => {
      const entry = findNodeEntryByMeshId(id);
      return entry?.node ? { id, entry } : null;
    })
    .filter(Boolean);

  if (entries.length < 2) {
    if (entries.length === 1) showNodeInfo(entries[0].entry);
    else clearInspector();
    return;
  }

  state.selectedNodeKey = null;

  const propMaps = entries.map(({ entry }) => {
    const map = new Map();
    for (const [label, value] of collectCompareProps(entry)) {
      map.set(label, value == null ? '' : String(value));
    }
    return map;
  });

  const labels = [];
  const seen = new Set();
  for (const map of propMaps) {
    for (const label of map.keys()) {
      if (seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
    }
  }

  const headers = entries.map(({ entry }, i) => {
    const name = nodePrimaryName(entry.node) || `板件${i + 1}`;
    return `<th title="${escapeHtml(name)}">${escapeHtml(name)}</th>`;
  }).join('');

  let diffCount = 0;
  const rows = labels.map((label) => {
    const values = propMaps.map((map) => map.get(label) || '');
    const allEmpty = values.every((v) => !v);
    if (allEmpty) return '';
    const same = values.every((v) => v === values[0]);
    if (!same) diffCount += 1;
    const cells = values
      .map((v) => `<td>${escapeHtml(v || '—')}</td>`)
      .join('');
    return `<tr class="${same ? 'is-same' : 'is-diff'}"><th>${escapeHtml(label)}</th>${cells}</tr>`;
  }).filter(Boolean).join('');

  el.inspectorBody.innerHTML = [
    `<div class="inspector-title">板件对比<span class="tag">${entries.length} 块</span></div>`,
    `<div class="compare-meta">差异 ${diffCount} 项 · 按住 Ctrl 继续加减选 · <label class="compare-only-diff"><input type="checkbox" id="compareOnlyDiff" /> 仅显示差异</label></div>`,
    `<div class="compare-scroll"><table class="inspector-table compare-table"><thead><tr><th>属性</th>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`,
  ].join('');

  const onlyDiff = el.inspectorBody.querySelector('#compareOnlyDiff');
  onlyDiff?.addEventListener('change', () => {
    const hideSame = onlyDiff.checked;
    el.inspectorBody.querySelectorAll('tr.is-same').forEach((tr) => {
      tr.style.display = hideSame ? 'none' : '';
    });
  });
}

function showSelectionInspector() {
  const ids = [...state.selectedIds];
  if (!ids.length) {
    clearInspector();
    return;
  }
  if (ids.length === 1) {
    showNodeInfoByMeshId(ids[0]);
    return;
  }
  showCompareInspector(ids);
}

function syncTreeSelectionUi() {
  el.tree.querySelectorAll('.tree-node, .tree-item, .tree-root-title').forEach((node) => {
    const id = node.dataset.id;
    if (id) node.classList.toggle('active', state.selectedIds.has(id));
    else node.classList.remove('active');
  });
}

function setSelectedIds(ids, { primaryId = null } = {}) {
  state.selectedIds.clear();
  for (const id of ids) {
    if (id && state.boardMeshes.has(id)) state.selectedIds.add(id);
  }
  state.selectedId = primaryId && state.selectedIds.has(primaryId)
    ? primaryId
    : ([...state.selectedIds].at(-1) || null);
}

function showNodeInfo(entry) {
  if (!el.inspectorBody) return;
  if (!entry?.node) {
    clearInspector();
    return;
  }

  const { node, meshId, extra = {} } = entry;
  const key = treeNodeKey(node, meshId || nodePrimaryName(node));
  state.selectedNodeKey = key;

  const name = nodePrimaryName(node);
  const kind = extra.kind === 'slot' ? '开槽' : nodeTypeTag(node);
  const tagClass = extra.kind === 'slot' ? 'tag slot' : 'tag';
  const size = node.size || node.boxSize || node.customSize;
  const holes = node.paramPlankPath?.holes?.length || 0;
  const slots = node.paramPlankPath?.slots?.length || 0;
  const bools = node.boolInterferenceModels?.length || 0;
  const childCount = (node.subModels || []).filter((c) => c && !c.deleted && !c.ignore).length;
  const thickness = node.thickness ?? size?.z;

  const basicRows = [
    inspectorRow('名称', name),
    inspectorRow('原始名', node.originalModelName && node.originalModelName !== name ? node.originalModelName : null),
    inspectorRow('商品名', node.modelBrandGoodName && node.modelBrandGoodName !== name ? node.modelBrandGoodName : null),
    inspectorRow('类型', kind),
    inspectorRow('ID', node.id || null),
    inspectorRow('实例 ID', node.modelInstanceId || null),
    inspectorRow('Mesh ID', meshId && meshId !== String(node.id || '') ? meshId : null),
    inspectorRow('编码', node.customCode || null),
    inspectorRow('型号', node.modelNumber || node.modelBrandGoodCode || null),
    inspectorRow('材质', node.textureName || null),
    inspectorRow('材质编号', node.textureProductNumber || null),
  ].join('');

  const geomRows = [
    inspectorRow('尺寸 (XYZ)', size ? formatVec3(size) : null),
    inspectorRow('厚度', thickness != null ? roundNum(thickness) : null),
    inspectorRow('相对位置', node.position ? formatVec3(node.position) : null),
    inspectorRow('绝对位置', node.absPosition ? formatVec3(node.absPosition) : null),
    inspectorRow('旋转(度)', node.absRotationDegree ? formatDeg(node.absRotationDegree)
      : (node.rotateDegree ? formatDeg(node.rotateDegree) : null)),
    inspectorRow('包围盒', node.absBoundingBox?.min && node.absBoundingBox?.max
      ? `${formatVec3(node.absBoundingBox.min)} → ${formatVec3(node.absBoundingBox.max)}`
      : null),
  ].join('');

  const relRows = [
    inspectorRow('根模型', extra.rootName || null),
    inspectorRow('宿主', extra.hostName || null),
    inspectorRow('布尔模型', extra.boolModelName || null),
    inspectorRow('子节点', childCount || null),
    inspectorRow('孔位', holes || null),
    inspectorRow('开槽路径', slots || null),
    inspectorRow('布尔干涉', bools || null),
  ].join('');

  const paramRows = renderParamRows(node.parameters);
  const ignoreParamRows = renderParamRows(node.ignoreParameters);

  const sections = [
    `<div class="inspector-title">${escapeHtml(name)}<span class="${tagClass}">${escapeHtml(kind)}</span></div>`,
    basicRows ? `<div class="inspector-section"><div class="inspector-section-title">基本信息</div><table class="inspector-table">${basicRows}</table></div>` : '',
    geomRows ? `<div class="inspector-section"><div class="inspector-section-title">几何</div><table class="inspector-table">${geomRows}</table></div>` : '',
    paramRows ? `<div class="inspector-section"><div class="inspector-section-title">参数 (${node.parameters.length})</div><table class="inspector-table">${paramRows}</table></div>` : '',
    ignoreParamRows ? `<div class="inspector-section"><div class="inspector-section-title">忽略参数 (${node.ignoreParameters.length})</div><table class="inspector-table inspector-table-muted">${ignoreParamRows}</table></div>` : '',
    relRows ? `<div class="inspector-section"><div class="inspector-section-title">关联</div><table class="inspector-table">${relRows}</table></div>` : '',
  ].filter(Boolean);

  el.inspectorBody.innerHTML = sections.join('') || '<div class="inspector-empty">无可用信息</div>';
}

function showNodeInfoByMeshId(id) {
  const entry = findNodeEntryByMeshId(id);
  if (entry) showNodeInfo(entry);
  else clearInspector();
}

function showNodeInfoByTreeKey(key) {
  const entry = findNodeEntryByTreeKey(key);
  if (entry) showNodeInfo(entry);
  else clearInspector();
}

function bboxAttr(node) {
  const bb = node.absBoundingBox;
  if (!bb?.min || !bb?.max) return '';
  const raw = [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].join(',');
  return ` data-bbox="${escapeHtml(raw)}"`;
}

function collectMeshIdsUnder(node) {
  return meshIdsUnder(node, nodePrimaryName(node));
}

function hideBtnHtml(ids) {
  if (!ids.length) return '';
  const joined = ids.join(',');
  const allHidden = ids.every((id) => state.hiddenIds.has(id));
  return (
    `<button type="button" class="hide-btn${allHidden ? ' is-off' : ''}"` +
      ` data-hide-ids="${escapeHtml(joined)}"` +
      ` title="${allHidden ? '显示' : '隐藏'}"` +
      ` aria-label="${allHidden ? '显示' : '隐藏'}">${allHidden ? '显' : '隐'}</button>`
  );
}

function treeToggleHtml(key, hasChildren, expanded) {
  if (!hasChildren) {
    return '<button type="button" class="tree-toggle is-leaf" tabindex="-1" aria-hidden="true">·</button>';
  }
  return (
    `<button type="button" class="tree-toggle" data-tree-key="${escapeHtml(key)}"` +
      ` title="${expanded ? '折叠' : '展开'}" aria-label="${expanded ? '折叠' : '展开'}">` +
      `${expanded ? '▼' : '▶'}</button>`
  );
}

function treeRowHtml({
  className,
  pad,
  selectId = '',
  hideIds = [],
  nodeKey = '',
  hasChildren = false,
  expanded = true,
  bbox = '',
  title = '',
  nameHtml,
  metaHtml = '',
  extraAttrs = '',
}) {
  const hidden = hideIds.length > 0 && hideIds.every((id) => state.hiddenIds.has(id));
  return (
    `<div class="${className}${hidden ? ' is-hidden' : ''}"` +
      `${pad != null ? ` style="padding-left:${pad}px"` : ''}` +
      `${selectId ? ` data-id="${escapeHtml(selectId)}"` : ''}` +
      `${nodeKey ? ` data-node-key="${escapeHtml(nodeKey)}"` : ''}` +
      `${hideIds.length ? ` data-hide-ids="${escapeHtml(hideIds.join(','))}"` : ''}` +
      `${bbox}` +
      `${extraAttrs}` +
      ` title="${escapeHtml(title)}">` +
      `${treeToggleHtml(nodeKey, hasChildren, expanded)}` +
      `${hideBtnHtml(hideIds)}` +
      `<div class="tree-node-body">` +
        `<div class="tree-name">${nameHtml}</div>` +
        `${metaHtml}` +
      `</div>` +
    `</div>`
  );
}

function setMeshesHidden(ids, hidden) {
  for (const id of ids) {
    const group = state.boardMeshes.get(id);
    if (!group) continue;
    if (hidden) state.hiddenIds.add(id);
    else state.hiddenIds.delete(id);
    group.visible = !state.hiddenIds.has(id);
  }
  rebuildPickables();
  syncHiddenUi();
  requestRender();
}

function getSelectedHideIds() {
  if (state.selectedIds.size) return [...state.selectedIds];
  if (state.selectedNodeKey) {
    const ids = state.descendantMeshIds.get(state.selectedNodeKey);
    if (ids?.length) return [...ids];
  }
  const active = el.tree.querySelector('.tree-node.active, .tree-item.active, .tree-root-title.active');
  if (active?.dataset.hideIds) {
    const ids = (active.dataset.hideIds || '').split(',').filter(Boolean);
    if (ids.length) return ids;
  }
  if (state.selectedId && state.boardMeshes.has(state.selectedId)) {
    return [state.selectedId];
  }
  return [];
}

function hideSelectedNode() {
  const ids = getSelectedHideIds();
  if (!ids.length) {
    setStatus('请先选中要隐藏的节点');
    return;
  }
  setMeshesHidden(ids, true);
  setStatus(`已隐藏选中节点（${ids.length} 个对象）`);
}

function showAllNodes() {
  for (const id of [...state.hiddenIds]) {
    const group = state.boardMeshes.get(id);
    if (group) group.visible = true;
  }
  state.hiddenIds.clear();
  rebuildPickables();
  syncHiddenUi();
  requestRender();
  setStatus('已显示全部节点');
}

function syncHiddenUi() {
  el.tree.querySelectorAll('[data-hide-ids]').forEach((row) => {
    const ids = (row.dataset.hideIds || '').split(',').filter(Boolean);
    if (!ids.length) return;
    const allHidden = ids.every((id) => state.hiddenIds.has(id));
    row.classList.toggle('is-hidden', allHidden);
    const btn = row.querySelector(':scope > .hide-btn');
    if (!btn) return;
    btn.classList.toggle('is-off', allHidden);
    btn.title = allHidden ? '显示' : '隐藏';
    btn.setAttribute('aria-label', allHidden ? '显示' : '隐藏');
    btn.textContent = allHidden ? '显' : '隐';
  });
}

function applyHiddenState() {
  for (const [id, group] of state.boardMeshes) {
    group.visible = !state.hiddenIds.has(id);
  }
  syncHiddenUi();
}

function renderNodeRow(node, depth, parts) {
  if (!node || node.deleted || node.ignore) return;

  const id = node.id || node.modelInstanceId || '';
  const name = nodePrimaryName(node);
  const meta = nodeNameMeta(node);
  const tag = nodeTypeTag(node);
  const pad = 8 + depth * 12;
  const hasMesh = id && state.boardMeshes.has(String(id));
  const clickableId = hasMesh ? String(id) : '';
  const key = treeNodeKey(node, name);
  const children = (node.subModels || []).filter((c) => c && !c.deleted && !c.ignore);
  const hasChildren = children.length > 0;
  const expanded = !hasChildren || state.treeExpanded.has(key);
  const hideIds = [...new Set(meshIdsUnder(node, name))];

  parts.push(
    treeRowHtml({
      className: 'tree-node',
      pad,
      selectId: clickableId,
      hideIds,
      nodeKey: key,
      hasChildren,
      expanded,
      bbox: bboxAttr(node),
      title: [name, meta].filter(Boolean).join('\n'),
      nameHtml: `${escapeHtml(name)}<span class="tag">${escapeHtml(tag)}</span>`,
      metaHtml: meta ? `<div class="tree-sub">${escapeHtml(meta)}</div>` : '',
    }),
  );

  if (hasChildren && expanded) {
    for (const child of children) {
      renderNodeRow(child, depth + 1, parts);
    }
  }
}

function renderTree(roots, boards, cutters = []) {
  const parts = [];

  for (const root of roots) {
    const name = nodePrimaryName(root);
    const rootMeta = nodeNameMeta(root);
    const rootKey = treeNodeKey(root, name);
    const rootChildren = (root.subModels || []).filter((c) => c && !c.deleted && !c.ignore);
    const rootHasChildren = rootChildren.length > 0;
    const rootExpanded = !rootHasChildren || state.treeExpanded.has(rootKey);
    const rootHideIds = [...new Set(meshIdsUnder(root, name))];
    parts.push(`<div class="tree-root">`);
    parts.push(
      treeRowHtml({
        className: 'tree-root-title',
        hideIds: rootHideIds,
        nodeKey: rootKey,
        hasChildren: rootHasChildren,
        expanded: rootExpanded,
        bbox: bboxAttr(root),
        title: [name, rootMeta].filter(Boolean).join('\n'),
        nameHtml: escapeHtml(name),
        metaHtml: rootMeta ? `<div class="tree-sub">${escapeHtml(rootMeta)}</div>` : '',
        extraAttrs: ` data-root="${escapeHtml(name)}"`,
      }),
    );
    if (rootExpanded) {
      for (const child of rootChildren) {
        renderNodeRow(child, 1, parts);
      }
      if (isBoard(root) && !rootChildren.length) {
        renderNodeRow(root, 0, parts);
      }
    }
    parts.push(`</div>`);
  }

  if (cutters.length) {
    const slotIds = cutters.map((c) => c.id).filter((id) => state.boardMeshes.has(id));
    const slotsExpanded = state.treeExpanded.has('布尔开槽');
    parts.push(`<div class="tree-root">`);
    parts.push(
      treeRowHtml({
        className: 'tree-root-title',
        hideIds: slotIds,
        nodeKey: '布尔开槽',
        hasChildren: true,
        expanded: slotsExpanded,
        title: '布尔开槽',
        nameHtml: `布尔开槽（${cutters.length}）`,
        extraAttrs: ' data-root="布尔开槽"',
      }),
    );
    if (slotsExpanded) {
      for (const cutter of cutters) {
        const node = cutter.node;
        const name = nodePrimaryName(node);
        const metaBits = [
          cutter.boolModelName && cutter.boolModelName !== name ? cutter.boolModelName : null,
          cutter.hostName ? `宿主:${cutter.hostName}` : null,
          nodeNameMeta(node),
        ].filter(Boolean);
        const meta = metaBits.join(' · ');
        const hideIds = state.boardMeshes.has(cutter.id) ? [cutter.id] : [];
        parts.push(
          treeRowHtml({
            className: 'tree-node',
            pad: 20,
            selectId: cutter.id,
            hideIds,
            nodeKey: treeNodeKey(node, cutter.id),
            hasChildren: false,
            expanded: true,
            bbox: bboxAttr(node),
            title: [name, meta].filter(Boolean).join('\n'),
            nameHtml: `${escapeHtml(name)}<span class="tag slot">开槽</span>`,
            metaHtml: meta ? `<div class="tree-sub">${escapeHtml(meta)}</div>` : '',
          }),
        );
      }
    }
    parts.push(`</div>`);
  }

  el.tree.innerHTML = parts.join('') || '<div class="meta">无节点</div>';
  applyHiddenState();
  syncSearchTreeUi();
  syncTreeSelectionUi();
}

function focusBBoxString(raw) {
  if (!raw) return false;
  const nums = raw.split(',').map(Number);
  if (nums.length !== 6 || nums.some((n) => Number.isNaN(n))) return false;
  const [x0, y0, z0, x1, y1, z1] = nums;
  // KJL -> Three: (x,y,z) -> (x,z,-y)
  const min = new THREE.Vector3(Math.min(x0, x1), Math.min(z0, z1), -Math.max(y0, y1));
  const max = new THREE.Vector3(Math.max(x0, x1), Math.max(z0, z1), -Math.min(y0, y1));
  const box = new THREE.Box3(min, max);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const dist = Math.max(size.length() * 1.3, 400);
  const dir = state.camera.position.clone().sub(state.controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(1, 0.8, 1);
  dir.normalize().multiplyScalar(dist);
  state.camera.position.copy(center).add(dir);
  state.controls.target.copy(center);
  state.controls.update();
  requestRender();
  return true;
}

function selectBoard(id, { additive = false } = {}) {
  if (!id || !state.boardMeshes.has(id)) return;

  if (additive) {
    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else state.selectedIds.add(id);
    state.selectedId = state.selectedIds.has(id)
      ? id
      : ([...state.selectedIds].at(-1) || null);
  } else {
    setSelectedIds([id], { primaryId: id });
  }

  const focusId = additive ? id : state.selectedId;
  const entry = focusId ? findNodeEntryByMeshId(focusId) : null;
  if (entry) {
    const treeKey = treeNodeKey(entry.node, focusId);
    if (treeKey) {
      const before = state.treeExpanded.size;
      expandTreePathToKey(treeKey);
      if (state.treeExpanded.size !== before) {
        renderTree(state.treeRoots, state.boards, state.treeCutters);
      }
    }
  }

  applyMeshHighlights();
  syncTreeSelectionUi();
  showSelectionInspector();

  const count = state.selectedIds.size;
  if (count > 1) setStatus(`已多选 ${count} 块板件，右侧可对比属性`);
  else if (count === 1) setStatus(`已选中 1 块板件`);
  else setStatus('已取消选中');
  requestRender();
}

function selectTreeNode(row, { additive = false } = {}) {
  if (!row) return;
  const treeKey = row.dataset.nodeKey || '';

  if (row.dataset.id) {
    selectBoard(row.dataset.id, { additive });
    return;
  }

  if (additive) return;

  state.selectedId = null;
  state.selectedIds.clear();
  applyMeshHighlights();
  el.tree.querySelectorAll('.tree-node, .tree-item, .tree-root-title').forEach((node) => {
    node.classList.toggle('active', node === row);
  });
  if (treeKey) {
    expandTreePathToKey(treeKey);
    showNodeInfoByTreeKey(treeKey);
  } else {
    clearInspector();
  }
  if (row.dataset.bbox) focusBBoxString(row.dataset.bbox);
  requestRender();
}

function fitCameraToScene() {
  if (!state.rootGroup) return;
  const box = new THREE.Box3().setFromObject(state.rootGroup);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const dist = maxDim * 1.6;
  state.controls.target.copy(center);
  state.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.55, center.z + dist * 0.7);
  state.camera.near = Math.max(0.1, dist / 1000);
  state.camera.far = Math.max(10000, dist * 20);
  state.camera.updateProjectionMatrix();
  state.controls.update();
  requestRender();
}

function initThree() {
  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(50, 1, 1, 100000);
  camera.position.set(3000, 2500, 3000);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  el.viewport.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  const dir = new THREE.DirectionalLight(0xffffff, 0.85);
  dir.position.set(0.6, 1, 0.4);
  const fill = new THREE.DirectionalLight(0xb0c4de, 0.35);
  fill.position.set(-0.5, 0.3, -0.6);
  scene.add(ambient, dir, fill);

  const grid = new THREE.GridHelper(10000, 20, 0x3a4252, 0x2a303c);
  grid.position.y = 0;
  scene.add(grid);

  state.scene = scene;
  state.camera = camera;
  state.renderer = renderer;
  state.controls = controls;
  state.rootGroup = new THREE.Group();
  scene.add(state.rootGroup);

  const resize = () => {
    const w = el.viewport.clientWidth;
    const h = el.viewport.clientHeight;
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    requestRender();
  };
  window.addEventListener('resize', resize);
  resize();

  controls.addEventListener('start', startInteractiveRender);
  controls.addEventListener('end', () => stopInteractiveRender(180));
  controls.addEventListener('change', requestRender);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(state.pickables, false);
    if (hits.length) {
      const pickId = hits[0].object.userData.pickId;
      if (pickId) selectBoard(pickId, { additive: ev.ctrlKey || ev.metaKey });
    }
  });

  requestRender();
}

async function loadJsonText(text, label) {
  setStatus(`正在解析 ${label}…`);
  let data;
  try {
    const cleaned = text.replace(/^\uFEFF/, '');
    data = JSON.parse(cleaned);
  } catch (e) {
    setStatus(`JSON 解析失败：${e.message}`, true);
    return;
  }
  if (!data || typeof data !== 'object' || !data.paramModel) {
    setStatus('不是有效的酷家乐方案（缺少 paramModel）', true);
    return;
  }
  try {
    buildSceneFromData(data, label);
  } catch (e) {
    console.error(e);
    setStatus(`构建场景失败：${e.message}`, true);
  }
}

function bindUi() {
  el.fileInput.addEventListener('change', async () => {
    const file = el.fileInput.files?.[0];
    if (!file) return;
    try {
      setStatus(`正在读取 ${file.name}…`);
      const text = await file.text();
      await loadJsonText(text, file.name);
    } catch (e) {
      console.error(e);
      setStatus(`读取文件失败：${e.message}`, true);
    } finally {
      el.fileInput.value = '';
    }
  });

  el.fitBtn.addEventListener('click', fitCameraToScene);
  el.showAllBtn.addEventListener('click', showAllNodes);

  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'h' && ev.key !== 'H') return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const tag = (ev.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || ev.target?.isContentEditable) return;
    ev.preventDefault();
    hideSelectedNode();
  });

  let searchTimer = null;
  el.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(el.searchInput.value), 250);
  });
  el.searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      clearTimeout(searchTimer);
      runSearch(el.searchInput.value);
    } else if (ev.key === 'Escape') {
      clearSearch();
      setStatus('已清除搜索');
    }
  });
  el.searchClearBtn.addEventListener('click', () => {
    clearSearch();
    setStatus('已清除搜索');
  });
  el.searchResults.addEventListener('click', (ev) => {
    const item = ev.target.closest('.search-result-item');
    if (!item) return;
    focusSearchMatch(Number(item.dataset.searchIndex));
  });

  el.showHoles.addEventListener('change', () => {
    const visible = el.showHoles.checked;
    for (const group of state.boardMeshes.values()) {
      group.traverse((o) => {
        if (o.name === 'holeOutlines') o.visible = visible;
      });
    }
    requestRender();
  });

  el.showSlots.addEventListener('change', () => {
    if (state.slotGroup) state.slotGroup.visible = el.showSlots.checked;
    requestRender();
  });

  el.tree.addEventListener('click', (ev) => {
    const toggleBtn = ev.target.closest('.tree-toggle[data-tree-key]');
    if (toggleBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      toggleTreeNode(toggleBtn.dataset.treeKey);
      return;
    }

    const hideBtn = ev.target.closest('.hide-btn');
    if (hideBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const ids = (hideBtn.dataset.hideIds || '').split(',').filter(Boolean);
      if (!ids.length) return;
      const shouldHide = !ids.every((id) => state.hiddenIds.has(id));
      setMeshesHidden(ids, shouldHide);
      return;
    }

    const item = ev.target.closest('.tree-node, .tree-item, .tree-root-title');
    if (item) {
      selectTreeNode(item, { additive: ev.ctrlKey || ev.metaKey });
    }
  });

  el.inspectorCloseBtn?.addEventListener('click', () => {
    state.selectedId = null;
    state.selectedIds.clear();
    applyMeshHighlights();
    syncTreeSelectionUi();
    clearInspector();
    requestRender();
  });

  ['dragenter', 'dragover'].forEach((type) => {
    el.viewport.addEventListener(type, (e) => {
      e.preventDefault();
      el.dropHint.classList.add('visible');
    });
  });
  el.viewport.addEventListener('dragleave', (e) => {
    e.preventDefault();
    el.dropHint.classList.remove('visible');
  });
  el.viewport.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.dropHint.classList.remove('visible');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      setStatus(`正在读取 ${file.name}…`);
      const text = await file.text();
      await loadJsonText(text, file.name);
    } catch (err) {
      console.error(err);
      setStatus(`读取文件失败：${err.message}`, true);
    }
  });
}

initThree();
bindUi();
