/**
 * The editor's 3D preview: the normalised model on field tiles, the 18-in cube, the measured hull
 * on the floor, the wheel contacts, a front arrow, and the mechanism placements. Everything is in
 * the MODEL frame (inches, +x front, +y left, +z up, origin at the footprint's box centre), which
 * does not move when a wheel is dragged. Renders on demand: a frame per control change or
 * `update`, nothing while idle.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { ImportedMech, Vec2 } from '../../types';
import { bbox, triangleBody, type MeshPart } from '../geometry';
import type { MotionPart } from '../types';
import { splitMoving } from './bakeScene';
import type { GizmoLayer } from './gizmo';
import { buildMeshGroup, creaseParts, disposeTree } from './meshGroup';

/** one placement the player can drag in the 3D view (MODEL frame, inches; `ui/mechMove.ts` writes it back) */
export interface GizmoHandle {
  /** `shooter`, `place`, `intake:front:from` ... (the editor's own key) */
  key: string;
  label: string;
  x: number;
  y: number;
  z: number;
  /** a point (a launcher, where it places), a span's end or middle, or a fixed launcher's FACING tip */
  shape: 'point' | 'end' | 'mid' | 'aim';
  /** a span's handles slide along one model axis only */
  axis?: 'x' | 'y';
  bad?: boolean;
}

/** what the view tells the editor when a handle is picked or moved */
export interface GizmoCallbacks {
  select(key: string | null): void;
  move(key: string, p: { x: number; y: number; z: number }): void;
}

export interface PreviewState {
  /** the normalised model, MODEL frame (compared by identity): what a click picks, and what is drawn
   *  unless `shown` is set */
  parts: MeshPart[] | null;
  /** every triangle of a model kept at Full detail, MODEL frame (compared by identity): drawn in place
   *  of `parts`, which stay the hidden mesh a click is tested against (`NormalisedModel.shownParts`) */
  shown?: MeshPart[] | null;
  hull: Vec2[] | null;
  /** FL, FR, BL, BR */
  wheels: Vec2[] | null;
  /** every floor-contact cluster */
  contacts: Vec2[] | null;
  /** the wheelbase centre */
  origin: Vec2 | null;
  mech: ImportedMech | null;
  size: { length: number; width: number; height: number } | null;
  showCube: boolean;
  /** draw the shape physics uses: the footprint hull as a prism up to the model's height */
  showCollision: boolean;
  /** the moving parts as measured (MODEL frame, starting pose; compared by identity) */
  motion: MotionPart[] | null;
  /** run every moving part (wheels roll, rollers and flywheels turn, a turret sweeps, a ramp deploys
   *  and folds) — the editor's way of showing what was set up */
  playing: boolean;
  /** bodies to tint: the moving part being edited (`active`) and the others */
  highlight: { active: number[]; others: number[] } | null;
  /** clicking a part reports its body (`onPickBody`); hovering tints it */
  picking: boolean;
  /** the placements to edit in 3D, with the selected one under the move gizmo; null = none */
  gizmo: { handles: GizmoHandle[]; selected: string | null } | null;
}

/** the editor's camera presets (lane 4) */
export type PreviewView = 'iso' | 'top' | 'front' | 'side';

export interface PreviewController {
  update(state: Partial<PreviewState>): void;
  resize(width: number, height: number): void;
  /** back to the default 3/4 view */
  resetView(): void;
  /** one of the camera presets, framed on the model */
  setView(view: PreviewView): void;
  /** called with the body under a click while `picking` (`shift`: the one body, not its axle); -1 is
   *  a click on nothing */
  onPickBody(cb: ((body: number, shift: boolean) => void) | null): void;
  /** called with the bodies a box drag takes while `picking` (`BoxPick`) */
  onPickBox(cb: ((pick: BoxPick) => void) | null): void;
  /** called when a placement handle is picked or dragged while `gizmo` is set */
  onGizmo(cb: GizmoCallbacks | null): void;
  dispose(): void;
}

/**
 * A box dragged with the left button while `picking` (the Onshape rule): dragged left to right it takes
 * the bodies wholly inside it, right to left every body it touches. Hidden bodies count, as there.
 * `remove`: Ctrl (Cmd) was held, so the box takes them out instead.
 */
export interface BoxPick {
  bodies: number[];
  crossing: boolean;
  remove: boolean;
}

const TILE_IN = 24;
const CUBE_IN = 18;
const COLORS = {
  tile: 0x5c6066,
  seam: 0x3a3d42,
  cube: 0xd8dde3,
  cubeOver: 0xf0a020,
  hull: 0x3fb6ff,
  wheel: 0x58d68d,
  contact: 0xb0b8c0,
  origin: 0xffffff,
  front: 0xffffff,
  intake: 0x58d68d,
  shooter: 0xff7a45,
  place: 0xc58cff,
  pickActive: 0x36c5ff,
  pickOther: 0xffb347,
  pickHover: 0xffffff,
};

function line(points: THREE.Vector3[], color: number, loop = false): THREE.Line {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const m = new THREE.LineBasicMaterial({ color, depthTest: true });
  return loop ? new THREE.LineLoop(g, m) : new THREE.Line(g, m);
}

function marker(radius: number, color: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.12, 24), new THREE.MeshBasicMaterial({ color }));
  m.rotation.x = Math.PI / 2; // cylinder axis y → z
  return m;
}

export function createPreview(canvas: HTMLCanvasElement, initial: Partial<PreviewState> = {}): PreviewController {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  // something for a metal finish to reflect (`finishOf`): the match lights robots the same way
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envMap = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  scene.environment = envMap;
  scene.environmentIntensity = 0.4;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x50555c, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(30, 20, 60);
  scene.add(key);

  // three tiles a side, with seams
  const floor = new THREE.Group();
  const tiles = new THREE.Mesh(new THREE.PlaneGeometry(TILE_IN * 3, TILE_IN * 3), new THREE.MeshStandardMaterial({ color: COLORS.tile, roughness: 0.95 }));
  floor.add(tiles);
  for (let i = -1; i <= 2; i++) {
    const c = (i - 0.5) * TILE_IN;
    floor.add(line([new THREE.Vector3(c, -1.5 * TILE_IN, 0.01), new THREE.Vector3(c, 1.5 * TILE_IN, 0.01)], COLORS.seam));
    floor.add(line([new THREE.Vector3(-1.5 * TILE_IN, c, 0.01), new THREE.Vector3(1.5 * TILE_IN, c, 0.01)], COLORS.seam));
  }
  scene.add(floor);

  const cubeMat = new THREE.LineBasicMaterial({ color: COLORS.cube, transparent: true, opacity: 0.7 });
  const cube = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(CUBE_IN, CUBE_IN, CUBE_IN)), cubeMat);
  cube.position.set(0, 0, CUBE_IN / 2);
  scene.add(cube);

  const overlays = new THREE.Group();
  scene.add(overlays);
  let model: THREE.Group | null = null;
  /** what a click is tested against when `shown` is drawn: the measured parts, never drawn, so the
   *  ray walks a quarter of a million triangles and not every one of the CAD */
  let pickModel: THREE.Group | null = null;

  const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 2000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 10;
  controls.maxDistance = 250;
  // THE ONSHAPE MOUSE: the right button orbits (Ctrl or Shift with it pans), the middle pans, the
  // wheel zooms. The left button orbits too until parts are being picked, when it draws a box.
  const orbitLeft = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  const boxLeft = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  controls.mouseButtons = orbitLeft;

  const state: PreviewState = {
    parts: null,
    shown: null,
    hull: null,
    wheels: null,
    contacts: null,
    origin: null,
    mech: null,
    size: null,
    showCube: true,
    showCollision: false,
    motion: null,
    playing: false,
    highlight: null,
    picking: false,
    gizmo: null,
  };
  /** the moving parts' nodes, posed by the play loop */
  let moving: { node: THREE.Object3D; part: MotionPart; turret: number; angle: number; rest: THREE.Vector3 }[] = [];
  const tints = new THREE.Group();
  scene.add(tints);
  let hover = -1;
  let pickCb: ((body: number, shift: boolean) => void) | null = null;
  let boxCb: ((pick: BoxPick) => void) | null = null;

  let frame = 0;
  const render = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderer.render(scene, camera);
    });
  };
  controls.addEventListener('change', render);

  const resetView = (): void => setView('iso');
  function setView(view: PreviewView): void {
    const h = state.size?.height ?? 12;
    controls.target.set(0, 0, h / 2);
    // straight down needs an up that is not the view axis: front (+x) up on screen
    camera.up.set(0, 0, 1);
    if (view === 'top') {
      camera.position.set(0.01, 0, 70 + h);
      camera.up.set(1, 0, 0);
    } else if (view === 'front') camera.position.set(62, 0, h / 2 + 4);
    else if (view === 'side') camera.position.set(0, 62, h / 2 + 4);
    else camera.position.set(36, 30, 26 + h / 2);
    camera.lookAt(controls.target);
    controls.update();
    camera.up.set(0, 0, 1);
    render();
  }

  const rebuildOverlays = (): void => {
    disposeTree(overlays);
    overlays.clear();
    const z = 0.06;
    if (state.hull && state.hull.length >= 3) {
      overlays.add(line(state.hull.map((p) => new THREE.Vector3(p.x, p.y, z)), COLORS.hull, true));
      // front arrow just past the hull's front edge
      const b = bbox(state.hull);
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(b.maxX + 1.5, (b.minY + b.maxY) / 2, z), 5, COLORS.front, 1.6, 1.2);
      overlays.add(arrow);
    }
    for (const c of state.contacts ?? []) {
      const m = marker(0.35, COLORS.contact);
      m.position.set(c.x, c.y, z);
      overlays.add(m);
    }
    for (const w of state.wheels ?? []) {
      const m = marker(0.8, COLORS.wheel);
      m.position.set(w.x, w.y, z + 0.02);
      overlays.add(m);
    }
    if (state.origin) {
      const o = state.origin;
      overlays.add(line([new THREE.Vector3(o.x - 1, o.y, z), new THREE.Vector3(o.x + 1, o.y, z)], COLORS.origin));
      overlays.add(line([new THREE.Vector3(o.x, o.y - 1, z), new THREE.Vector3(o.x, o.y + 1, z)], COLORS.origin));
    }
    const mech = state.mech;
    if (mech && state.hull && state.hull.length >= 3) {
      const b = bbox(state.hull);
      for (const it of mech.intakes ?? []) {
        const zz = 0.5;
        const pts =
          it.edge === 'front'
            ? [new THREE.Vector3(b.maxX, it.from, zz), new THREE.Vector3(b.maxX, it.to, zz)]
            : it.edge === 'back'
              ? [new THREE.Vector3(b.minX, it.from, zz), new THREE.Vector3(b.minX, it.to, zz)]
              : it.edge === 'left'
                ? [new THREE.Vector3(it.from, b.maxY, zz), new THREE.Vector3(it.to, b.maxY, zz)]
                : [new THREE.Vector3(it.from, b.minY, zz), new THREE.Vector3(it.to, b.minY, zz)];
        const dir = new THREE.Vector3().subVectors(pts[1], pts[0]);
        const bar = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.6, Math.abs(dir.x)), Math.max(0.6, Math.abs(dir.y)), 0.6), new THREE.MeshBasicMaterial({ color: COLORS.intake }));
        bar.position.copy(pts[0]).add(pts[1]).multiplyScalar(0.5);
        overlays.add(bar);
      }
      for (const [p, color] of [[mech.shooter, COLORS.shooter], [mech.place, COLORS.place]] as const) {
        if (!p) continue;
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), new THREE.MeshBasicMaterial({ color }));
        s.position.set(p.x, p.y, p.z);
        overlays.add(s);
        overlays.add(line([new THREE.Vector3(p.x, p.y, 0.05), new THREE.Vector3(p.x, p.y, p.z)], color));
      }
    }
    if (state.showCollision && state.hull && state.hull.length >= 3 && state.size) {
      const top = state.size.height;
      const ring = (z: number): THREE.Vector3[] => state.hull!.map((p) => new THREE.Vector3(p.x, p.y, z));
      overlays.add(line(ring(top), COLORS.hull, true));
      for (const p of state.hull) overlays.add(line([new THREE.Vector3(p.x, p.y, z), new THREE.Vector3(p.x, p.y, top)], COLORS.hull));
    }
    const over = !!state.size && Math.max(state.size.length, state.size.width, state.size.height) > CUBE_IN + 1 / 64;
    cubeMat.color.setHex(over ? COLORS.cubeOver : COLORS.cube);
    cube.visible = state.showCube;
  };

  /**
   * THE MODEL, with each moving part a node of its own at its pivot (the stored mesh's layout,
   * `bakeMesh.ts`), so the play loop can turn it about its axis; a rider is its carrier's child.
   */
  const buildModel = (): void => {
    if (model) {
      scene.remove(model);
      disposeTree(model);
      model = null;
    }
    if (pickModel) {
      disposeTree(pickModel);
      pickModel = null;
    }
    moving = [];
    if (!state.parts) return;
    if (state.shown) {
      pickModel = buildMeshGroup(state.parts, 'pick');
      pickModel.updateMatrixWorld(true);
    }
    const parts = creaseParts(state.shown ?? state.parts);
    const motion = state.motion ?? [];
    const { rest, moving: groups } = splitMoving(parts, motion);
    model = buildMeshGroup(rest, 'preview');
    const nodes: (THREE.Group | null)[] = motion.map(() => null);
    let turrets = 0;
    const make = (i: number, depth = 0): THREE.Group | null => {
      if (nodes[i] || depth > 8) return nodes[i];
      const m = motion[i];
      const parent = m.parent >= 0 && m.parent !== i ? make(m.parent, depth + 1) : null;
      const node = new THREE.Group();
      const base = parent ? motion[m.parent].pivot : [0, 0, 0];
      node.position.set(m.pivot[0] - base[0], m.pivot[1] - base[1], m.pivot[2] - base[2]);
      const shifted = groups[i].map((p) => {
        const a = new Float32Array(p.positions.length);
        for (let k = 0; k < a.length; k += 3) {
          a[k] = p.positions[k] - m.pivot[0];
          a[k + 1] = p.positions[k + 1] - m.pivot[1];
          a[k + 2] = p.positions[k + 2] - m.pivot[2];
        }
        return { ...p, positions: a };
      });
      const meshes = buildMeshGroup(shifted, 'moving');
      for (const c of [...meshes.children]) node.add(c);
      (parent ?? model!).add(node);
      nodes[i] = node;
      moving.push({ node, part: m, turret: m.role === 'turret' ? turrets++ : 0, angle: 0, rest: node.position.clone() });
      return node;
    };
    for (let i = 0; i < motion.length; i++) make(i);
    scene.add(model);
  };

  /** the triangles of `bodies` as one tinted overlay (starting pose; picking stops the play loop) */
  const tint = (bodies: ReadonlySet<number>, color: number, opacity: number): THREE.Mesh | null => {
    if (!state.parts || !bodies.size) return null;
    const pos: number[] = [];
    for (const p of state.parts) {
      if (!p.body) continue;
      const n = Math.floor((p.indices ? p.indices.length : p.positions.length / 3) / 3);
      for (let t = 0; t < n; t++) {
        if (!bodies.has(triangleBody(p, t))) continue;
        for (let c = 0; c < 3; c++) {
          const v = p.indices ? p.indices[3 * t + c] : 3 * t + c;
          pos.push(p.positions[3 * v], p.positions[3 * v + 1], p.positions[3 * v + 2]);
        }
      }
    }
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    return new THREE.Mesh(g, mat);
  };
  const rebuildTints = (): void => {
    disposeTree(tints);
    tints.clear();
    const h = state.highlight;
    const others = tint(new Set(h?.others ?? []), COLORS.pickOther, 0.35);
    const active = tint(new Set(h?.active ?? []), COLORS.pickActive, 0.55);
    const hov = state.picking && hover >= 0 ? tint(new Set([hover]), COLORS.pickHover, 0.45) : null;
    for (const m of [others, active, hov]) if (m) tints.add(m);
  };

  // ---- placement handles: drawn, picked and moved in 3D by `gizmo.ts` -----------------------------
  // LAZY (bundleaudit's `gizmo` route): the layer and three's TransformControls are fetched the first
  // time a state carries `gizmo`, so the engine chunk carries neither for the steps that do not edit a
  // placement. Until the layer lands the view shows no handles; the map and the fields still move them.
  let layer: GizmoLayer | null = null;
  let layerLoad: Promise<void> | null = null;
  let disposed = false;
  let gizmoCb: GizmoCallbacks | null = null;
  const loadLayer = (): void => {
    if (layerLoad) return;
    layerLoad = import('./gizmo').then(
      ({ createGizmoLayer }) => {
        if (disposed) return;
        layer = createGizmoLayer({
          scene,
          camera,
          canvas,
          controls,
          render,
          state,
          callbacks: () => gizmoCb,
          colors: { intake: COLORS.intake, shooter: COLORS.shooter, place: COLORS.place },
        });
        layer.update(null);
        render();
      },
      (err) => {
        // offline, or a deploy replaced the chunk: the map and the fields still move the placements
        console.warn('[import] the 3D handles did not load', err);
        layerLoad = null;
      },
    );
  };
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  // ---- picking: a click (not a drag) on a part reports its body ---------------------------------
  const bodyAt = (clientX: number, clientY: number): number => {
    const target = pickModel ?? model;
    if (!target) return -1;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return -1;
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(target, true)[0];
    const geo = (hit?.object as THREE.Mesh | undefined)?.geometry as THREE.BufferGeometry | undefined;
    const attr = geo?.getAttribute('_body');
    if (!hit?.face || !attr) return -1;
    return Math.round(attr.getX(hit.face.a));
  };
  /** every body with a vertex (`crossing`) or all of its vertices (window) inside the screen box */
  const bodiesInBox = (x0: number, y0: number, x1: number, y1: number, crossing: boolean): number[] => {
    if (!state.parts) return [];
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return [];
    const nx = (x: number): number => ((x - r.left) / r.width) * 2 - 1;
    const ny = (y: number): number => -((y - r.top) / r.height) * 2 + 1;
    const minX = Math.min(nx(x0), nx(x1));
    const maxX = Math.max(nx(x0), nx(x1));
    const minY = Math.min(ny(y0), ny(y1));
    const maxY = Math.max(ny(y0), ny(y1));
    camera.updateMatrixWorld();
    const e = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    // body → every vertex inside so far (window), or any vertex inside (crossing)
    const hit = new Map<number, boolean>();
    for (const p of state.parts) {
      if (!p.body) continue;
      const pos = p.positions;
      for (let v = 0; v < p.body.length; v++) {
        const b = p.body[v];
        const had = hit.get(b);
        if (crossing ? had : had === false) continue;
        const x = pos[3 * v];
        const y = pos[3 * v + 1];
        const z = pos[3 * v + 2];
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        let inside = w > 0;
        if (inside) {
          const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
          const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
          inside = cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
        }
        hit.set(b, crossing ? inside : (had ?? true) && inside);
      }
    }
    return [...hit].filter(([, v]) => v).map(([b]) => b).sort((a, b) => a - b);
  };
  /** the box drawn while dragging (a div over the canvas: `.ds-import-box`, dashed when crossing) */
  let boxEl: HTMLDivElement | null = null;
  const drawBox = (x0: number, y0: number, x1: number, y1: number): void => {
    const host = canvas.parentElement;
    if (!host) return;
    if (!boxEl) {
      boxEl = document.createElement('div');
      boxEl.className = 'ds-import-box';
      host.appendChild(boxEl);
    }
    const hr = host.getBoundingClientRect();
    boxEl.classList.toggle('cross', x1 < x0);
    boxEl.style.left = `${Math.min(x0, x1) - hr.left}px`;
    boxEl.style.top = `${Math.min(y0, y1) - hr.top}px`;
    boxEl.style.width = `${Math.abs(x1 - x0)}px`;
    boxEl.style.height = `${Math.abs(y1 - y0)}px`;
  };
  const endBox = (): void => {
    boxEl?.remove();
    boxEl = null;
  };
  let down: { x: number; y: number; t: number; button: number; box: boolean } | null = null;
  let hoverAt = 0;
  const onDown = (e: PointerEvent): void => {
    // a click that confirms a G-grab is the grab's alone
    if (layer?.down(e.clientX, e.clientY)) return;
    down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, box: false };
  };
  const onUp = (e: PointerEvent): void => {
    const d = down;
    down = null;
    if (!d || e.button !== 0 || d.button !== 0) return;
    if (d.box) {
      endBox();
      if (!state.picking || !boxCb) return;
      const crossing = e.clientX < d.x;
      boxCb({ bodies: bodiesInBox(d.x, d.y, e.clientX, e.clientY, crossing), crossing, remove: e.ctrlKey || e.metaKey });
      return;
    }
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 600) return;
    if (state.gizmo) {
      layer?.click(e.clientX, e.clientY);
      return;
    }
    if (!state.picking || !pickCb) return;
    pickCb(bodyAt(e.clientX, e.clientY), e.shiftKey);
  };
  const onMove = (e: PointerEvent): void => {
    if (layer?.move(e.clientX, e.clientY, down !== null)) return;
    if (down && down.button === 0 && state.picking && (down.box || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5)) {
      down.box = true;
      drawBox(down.x, down.y, e.clientX, e.clientY);
      return;
    }
    if (!state.picking || down) return;
    const now = performance.now();
    if (now - hoverAt < 70) return;
    hoverAt = now;
    const b = bodyAt(e.clientX, e.clientY);
    if (b === hover) return;
    hover = b;
    canvas.style.cursor = b >= 0 ? 'pointer' : '';
    rebuildTints();
    render();
  };
  const onLeave = (): void => {
    if (hover < 0) return;
    hover = -1;
    canvas.style.cursor = '';
    rebuildTints();
    render();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);

  // ---- play: every moving part runs, on a loop, until stopped -----------------------------------
  let playFrame = 0;
  let playLast = 0;
  let playT = 0;
  const pose = (dt: number): void => {
    playT += dt;
    // a ramp or a folding part deploys and folds back every four seconds
    const swing = 0.5 - 0.5 * Math.cos((playT * Math.PI) / 2);
    for (const m of moving) {
      const role = m.part.role;
      if (m.part.follows) continue; // after its leader, below
      if (role === 'wheel') m.angle += 4 * dt;
      else if (role === 'roller') m.angle += 9 * dt;
      else if (role === 'flywheel') m.angle += 16 * dt;
      else if (role === 'turret') m.angle = (m.turret ? -0.6 : 0.6) * Math.sin(playT * 1.3);
      else if (role === 'spin') m.angle += Math.min(26, (m.part.amount ?? 0) * 2 * Math.PI) * dt;
      else if (role === 'swing' || role === 'slide') m.angle = (m.part.amount ?? 0) * swing;
      else m.angle = m.part.deploy * swing;
      place(m);
    }
    // a geared part moves as its leader does, times the ratio
    for (let pass = 0; pass < 4; pass++) {
      for (const m of moving) {
        const f = m.part.follows;
        const lead = f ? moving.find((o) => o.part === state.motion?.[f.index]) : undefined;
        if (!f || !lead || lead === m) continue;
        m.angle = lead.angle * f.ratio;
        place(m);
      }
    }
  };
  /** a part at its value: a slide moved along its axis (inches, the model's own unit), the rest turned */
  const place = (m: (typeof moving)[number]): void => {
    if (m.part.role === 'slide') m.node.position.copy(m.rest).addScaledVector(new THREE.Vector3(...m.part.axis), m.angle);
    else m.node.quaternion.setFromAxisAngle(new THREE.Vector3(...m.part.axis), m.angle);
  };
  const still = (): void => {
    for (const m of moving) {
      m.angle = 0;
      m.node.position.copy(m.rest);
      m.node.quaternion.identity();
    }
  };
  const loop = (now: number): void => {
    playFrame = 0;
    if (!state.playing || state.picking) return;
    const dt = playLast ? Math.min(0.1, (now - playLast) / 1000) : 0;
    playLast = now;
    pose(dt);
    renderer.render(scene, camera);
    playFrame = requestAnimationFrame(loop);
  };
  const syncPlay = (): void => {
    if (state.playing && !state.picking) {
      if (!playFrame) {
        playLast = 0;
        playFrame = requestAnimationFrame(loop);
      }
    } else {
      if (playFrame) cancelAnimationFrame(playFrame);
      playFrame = 0;
      playT = 0;
      still();
    }
  };

  const update = (next: Partial<PreviewState>): void => {
    const modelChanged =
      (next.parts !== undefined && next.parts !== state.parts) ||
      (next.shown !== undefined && next.shown !== state.shown) ||
      (next.motion !== undefined && next.motion !== state.motion);
    const gizmoChanged = next.gizmo !== undefined && next.gizmo !== state.gizmo;
    const tintChanged = modelChanged || (next.highlight !== undefined && next.highlight !== state.highlight) || (next.picking !== undefined && next.picking !== state.picking);
    const was = state.gizmo?.selected ?? null;
    Object.assign(state, next);
    if (gizmoChanged) {
      if (state.gizmo) loadLayer();
      layer?.update(was);
    }
    controls.mouseButtons = state.picking ? boxLeft : orbitLeft;
    if (!state.picking) {
      down = null;
      endBox();
    }
    if (!state.picking && hover >= 0) {
      hover = -1;
      canvas.style.cursor = '';
    }
    if (modelChanged) buildModel();
    if (tintChanged) rebuildTints();
    rebuildOverlays();
    syncPlay();
    render();
  };

  const resize = (width: number, height: number): void => {
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    render();
  };

  resize(canvas.clientWidth || canvas.width || 640, canvas.clientHeight || canvas.height || 480);
  update(initial);
  resetView();

  return {
    update,
    resize,
    resetView,
    setView,
    onPickBody(cb): void {
      pickCb = cb;
    },
    onPickBox(cb): void {
      boxCb = cb;
    },
    onGizmo(cb): void {
      gizmoCb = cb;
    },
    dispose(): void {
      if (frame) cancelAnimationFrame(frame);
      if (playFrame) cancelAnimationFrame(playFrame);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      controls.removeEventListener('change', render);
      disposed = true;
      endBox();
      layer?.dispose();
      controls.dispose();
      disposeTree(scene);
      if (pickModel) disposeTree(pickModel);
      envMap.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
