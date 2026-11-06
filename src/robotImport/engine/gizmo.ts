/**
 * THE PLACEMENT HANDLES IN 3D (the Mechanisms step): every placement drawn as a handle over the model,
 * picked by a click, moved by three's move gizmo (TransformControls) or by a Blender-style G-grab.
 * MODEL frame, inches; what is moved goes back to the editor through `GizmoCallbacks.move`, and
 * `ui/mechMove.ts` writes it into the placements.
 *
 * LAZY: `preview.ts` reaches this by its own `import()` the first time a state carries `gizmo`, so the
 * engine chunk does not carry TransformControls (~7 KB gzipped) or this file for the steps that never
 * edit a placement (bundleaudit's `gizmo` route).
 *
 * Keys, while the pointer is over the view or a grab is on: G grabs the selected handle (it follows the
 * pointer until a click or Enter), X, Y or Z locks an axis (again: unlocks), Esc puts a grab back where
 * G was pressed, else drops the axis lock, else clears the selection.
 */
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { disposeTree } from './meshGroup';
import type { GizmoCallbacks, GizmoHandle, PreviewState } from './preview';

type Axis = 'x' | 'y' | 'z';
const AXES: readonly Axis[] = ['x', 'y', 'z'];
const BAD = 0xff5a5a;
const SELECTED = 0xffffff;

export interface GizmoContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  controls: OrbitControls;
  render: () => void;
  /** the preview's own state object, read live */
  state: PreviewState;
  callbacks: () => GizmoCallbacks | null;
  colors: { intake: number; shooter: number; place: number };
}

/** what `preview.ts` asks of the layer */
export interface GizmoLayer {
  /** `state.gizmo` changed; `was` is the key selected before */
  update(was: string | null): void;
  /** a pointer went down: true when it confirmed a grab (nothing else may read it) */
  down(x: number, y: number): boolean;
  /** a click (not a drag) while handles are shown: pick the one under it */
  click(x: number, y: number): void;
  /** the pointer moved: true when a grab took it. `pressed`: a button is down (an orbit) */
  move(x: number, y: number, pressed: boolean): boolean;
  dragging(): boolean;
  dispose(): void;
}

function line(points: THREE.Vector3[], color: number): THREE.Line {
  const m = new THREE.LineBasicMaterial({ color, depthTest: false });
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), m);
  l.renderOrder = 10;
  return l;
}

export function createGizmoLayer(ctx: GizmoContext): GizmoLayer {
  const { scene, camera, canvas, controls, render, state } = ctx;
  // The handles are drawn over everything (depth test off): they sit INSIDE the robot, where a
  // depth-tested marker would be hidden by the very body the player is placing them on.
  const handleGroup = new THREE.Group();
  scene.add(handleGroup);
  const proxy = new THREE.Object3D();
  scene.add(proxy);
  const gizmo = new TransformControls(camera, canvas);
  gizmo.setMode('translate');
  gizmo.setSpace('world');
  gizmo.size = 0.85;
  const gizmoHelper = gizmo.getHelper();
  gizmoHelper.visible = false;
  scene.add(gizmoHelper);
  let lock: Axis | null = null;
  let hovered = false;
  let pointer = { x: 0, y: 0 };
  /** a G-grab in progress: the handle follows the pointer until a click or Enter. `origin` is where
   *  G was pressed, which Esc puts it back to (an X/Y/Z mid-grab starts a new `start` from where it is) */
  let grab: {
    key: string;
    origin: THREE.Vector3;
    start: THREE.Vector3;
    t0: number;
    offset: THREE.Vector3;
    axis: THREE.Vector3 | null;
    plane: THREE.Plane;
  } | null = null;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const selectedHandle = (): GizmoHandle | null => {
    const g = state.gizmo;
    return g?.selected ? (g.handles.find((h) => h.key === g.selected) ?? null) : null;
  };
  /** the axes a handle can move on: a span's one, a facing tip's two (the floor), a point's three */
  const allowedAxes = (h: GizmoHandle): Record<Axis, boolean> => {
    const a: Record<Axis, boolean> =
      h.shape === 'end' || h.shape === 'mid' ? { x: h.axis === 'x', y: h.axis === 'y', z: false } : h.shape === 'aim' ? { x: true, y: true, z: false } : { x: true, y: true, z: true };
    if (lock) for (const k of AXES) a[k] = a[k] && k === lock;
    return a;
  };
  const syncGizmo = (): void => {
    const h = selectedHandle();
    if (!h || grab) {
      gizmo.detach();
      gizmoHelper.visible = false;
      return;
    }
    // while it is dragged the gizmo follows the pointer; the handle (clamped) catches up on release
    if (!gizmo.dragging) proxy.position.set(h.x, h.y, h.z);
    gizmo.attach(proxy);
    gizmoHelper.visible = true;
    const a = allowedAxes(h);
    gizmo.showX = a.x;
    gizmo.showY = a.y;
    gizmo.showZ = a.z;
    gizmo.showXY = a.x && a.y && !lock;
    gizmo.showXZ = a.x && a.z && !lock;
    gizmo.showYZ = a.y && a.z && !lock;
  };
  const handleColor = (h: GizmoHandle): number =>
    h.bad ? BAD : h.key.startsWith('intake') ? ctx.colors.intake : h.key.startsWith('place') ? ctx.colors.place : ctx.colors.shooter;
  const rebuildHandles = (): void => {
    disposeTree(handleGroup);
    handleGroup.clear();
    const g = state.gizmo;
    if (!g) return;
    const mat = (color: number, on: boolean): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({ color: on ? new THREE.Color(color).lerp(new THREE.Color(SELECTED), 0.55) : color, depthTest: false, transparent: true, opacity: 0.95 });
    const add = (o: THREE.Object3D, key: string): void => {
      o.userData.key = key;
      o.renderOrder = 10;
      handleGroup.add(o);
    };
    const ends = new Map<string, GizmoHandle[]>();
    for (const h of g.handles) {
      const on = h.key === g.selected;
      const color = handleColor(h);
      const k = on ? 1.3 : 1;
      const at = new THREE.Vector3(h.x, h.y, h.z);
      let o: THREE.Mesh;
      if (h.shape === 'end') {
        const base = h.key.slice(0, h.key.lastIndexOf(':'));
        ends.set(base, [...(ends.get(base) ?? []), h]);
        o = new THREE.Mesh(new THREE.BoxGeometry(1.1 * k, 1.1 * k, 1.1 * k), mat(color, on));
      } else if (h.shape === 'mid') {
        o = new THREE.Mesh(new THREE.OctahedronGeometry(1.0 * k), mat(color, on));
      } else if (h.shape === 'aim') {
        o = new THREE.Mesh(new THREE.SphereGeometry(0.75 * k, 16, 12), mat(color, on));
        const from = g.handles.find((f) => f.key === h.key.slice(0, -':aim'.length));
        if (from) handleGroup.add(line([new THREE.Vector3(from.x, from.y, from.z), at], color));
      } else {
        o = new THREE.Mesh(new THREE.SphereGeometry(1.15 * k, 20, 14), mat(color, on));
        handleGroup.add(line([new THREE.Vector3(h.x, h.y, 0.05), at], color));
      }
      o.position.copy(at);
      add(o, h.key);
    }
    // a span's bar between its two ends: grabbing the bar is grabbing the span (its middle)
    for (const [base, pair] of ends) {
      if (pair.length < 2) continue;
      const [a, b] = pair;
      const mid = g.handles.find((o) => o.key === `${base}:mid`);
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(0.6, Math.abs(a.x - b.x)), Math.max(0.6, Math.abs(a.y - b.y)), 0.6),
        mat(mid ? handleColor(mid) : ctx.colors.intake, mid?.key === g.selected),
      );
      bar.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      bar.userData.bar = true;
      add(bar, `${base}:mid`);
    }
  };
  const aimAt = (x: number, y: number): void => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((x - r.left) / Math.max(1, r.width)) * 2 - 1, -((y - r.top) / Math.max(1, r.height)) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  const handleAt = (x: number, y: number): string | null => {
    aimAt(x, y);
    const hits = ray.intersectObjects(handleGroup.children.filter((o) => o.userData.key), false);
    // the small handles first: a bar covers its own ends, and the player means the end
    hits.sort((p, q) => Number(!!p.object.userData.bar) - Number(!!q.object.userData.bar) || p.distance - q.distance);
    return hits[0] ? String(hits[0].object.userData.key) : null;
  };
  const emitMove = (key: string, p: THREE.Vector3): void => ctx.callbacks()?.move(key, { x: p.x, y: p.y, z: p.z });
  gizmo.addEventListener('change', render);
  gizmo.addEventListener('dragging-changed', (e) => {
    controls.enabled = !e.value;
    if (!e.value) syncGizmo();
    render();
  });
  gizmo.addEventListener('objectChange', () => {
    const key = state.gizmo?.selected;
    if (key) emitMove(key, proxy.position);
  });

  // G: grab. The handle follows the pointer on the plane facing the camera, or along its one axis
  // (a span's own, or the X/Y/Z pressed), until a click or Enter; Esc puts it back. Blender's G.
  const rayOf = (): THREE.Ray => {
    aimAt(pointer.x, pointer.y);
    return ray.ray;
  };
  /** where along the line `o + t*d` the pointer's ray passes closest */
  const alongLine = (o: THREE.Vector3, d: THREE.Vector3): number => {
    const u = rayOf();
    const w = u.origin.clone().sub(o);
    const b = u.direction.dot(d);
    const den = 1 - b * b;
    return den < 1e-6 ? 0 : (d.dot(w) - b * u.direction.dot(w)) / den;
  };
  const grabPoint = (): THREE.Vector3 | null => {
    if (!grab) return null;
    if (grab.axis) return grab.start.clone().addScaledVector(grab.axis, alongLine(grab.start, grab.axis) - grab.t0);
    const hit = rayOf().intersectPlane(grab.plane, new THREE.Vector3());
    return hit ? hit.sub(grab.offset) : null;
  };
  const startGrab = (origin?: THREE.Vector3): void => {
    const h = selectedHandle();
    if (!h || grab || gizmo.dragging) return;
    const start = new THREE.Vector3(h.x, h.y, h.z);
    const a = allowedAxes(h);
    const open = AXES.filter((k) => a[k]);
    const axis = open.length === 1 ? new THREE.Vector3(+(open[0] === 'x'), +(open[0] === 'y'), +(open[0] === 'z')) : null;
    // two open axes move in their own plane (a facing tip on the floor); three move in the camera's
    const normal = open.length === 2 ? new THREE.Vector3(+!a.x, +!a.y, +!a.z) : camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, start);
    const first = rayOf().intersectPlane(plane, new THREE.Vector3());
    grab = { key: h.key, origin: origin ?? start, start, t0: axis ? alongLine(start, axis) : 0, offset: first ? first.sub(start) : new THREE.Vector3(), axis, plane };
    controls.enabled = false;
    canvas.style.cursor = 'move';
    syncGizmo();
  };
  const endGrab = (keep: boolean): void => {
    const g = grab;
    if (!g) return;
    grab = null;
    controls.enabled = true;
    canvas.style.cursor = '';
    if (!keep) emitMove(g.key, g.origin);
    syncGizmo();
    render();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!state.gizmo || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!hovered && !grab) return;
    const k = e.key.toLowerCase();
    if ((k === 'x' || k === 'y' || k === 'z') && selectedHandle()) {
      lock = lock === k ? null : k;
      // a grab starts again on the new axis from where the handle is now; Esc still goes back to
      // where G was pressed
      if (grab) {
        const origin = grab.origin;
        endGrab(true);
        startGrab(origin);
      } else syncGizmo();
      e.preventDefault();
      render();
    } else if (k === 'g' && selectedHandle()) {
      startGrab();
      e.preventDefault();
    } else if (e.key === 'Enter' && grab) {
      endGrab(true);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      if (grab) endGrab(false);
      else if (lock) {
        lock = null;
        syncGizmo();
      } else if (state.gizmo.selected) ctx.callbacks()?.select(null);
      else return;
      e.preventDefault();
      render();
    }
  };
  window.addEventListener('keydown', onKey);
  const onLeave = (): void => {
    hovered = false;
  };
  canvas.addEventListener('pointerleave', onLeave);

  return {
    update(was): void {
      // a different handle starts with every axis again, and a grab on a handle that is gone ends
      if ((state.gizmo?.selected ?? null) !== was) lock = null;
      if (grab && !state.gizmo?.handles.some((h) => h.key === grab!.key)) endGrab(true);
      rebuildHandles();
      syncGizmo();
    },
    down(x, y): boolean {
      pointer = { x, y };
      if (!grab) return false;
      // a click confirms a G-grab; the orbit and the gizmo were off for it
      endGrab(true);
      return true;
    },
    click(x, y): void {
      if (gizmo.dragging) return;
      const k = handleAt(x, y);
      if (k && k !== state.gizmo?.selected) ctx.callbacks()?.select(k);
    },
    move(x, y, pressed): boolean {
      pointer = { x, y };
      hovered = true;
      if (grab) {
        const p = grabPoint();
        if (p) emitMove(grab.key, p);
        return true;
      }
      if (state.gizmo && !pressed) canvas.style.cursor = handleAt(x, y) !== null ? 'pointer' : '';
      return false;
    },
    dragging: () => gizmo.dragging,
    dispose(): void {
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerleave', onLeave);
      gizmo.dispose();
      disposeTree(handleGroup);
    },
  };
}
