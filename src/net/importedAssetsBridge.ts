/**
 * THE ADAPTER between the visuals relay (`importVisualsClient.ts`) and the renderers' asset
 * registry (`src/render/importedAssets.ts`): `registerImportedAssets(id, { top?, mesh? }, owner)`
 * lends an in-memory blob that WINS over the device library, and `unregisterImportedAssets(id,
 * owner)` takes it back — "a mesh that arrived over a room's relay", in that file's own words.
 *
 * It exists so the relay holds one small seam and not the registry's whole surface, and so a check
 * can stand a recorder in for the registry (`setRelayedAssetSink`). It remembers what it has
 * delivered, so the relay can ask "do I already have this one?" without a second lookup.
 * DOM-free: it makes Blobs, nothing more.
 *
 * ⚠️ AN ASSET IS (OWNER, ROBOT ID), NOT A ROBOT ID. The renderers draw a robot's look by its id, so
 * a seat that claimed another seat's id could hand every viewer its own picture for that robot.
 * So each id is bound to the ONE owner (a roster client id) whose asset was delivered first; a
 * second owner's asset for the same id is refused here and by the registry, and taking assets back
 * is per owner. The room refuses a second seat holding one id as well; this is the viewer's half.
 */
import { registerImportedAssets, unregisterImportedAssets } from '../render/importedAssets';
import type { VisualKind } from './importVisuals';

export interface RelayedAssetSink {
  /** `owner`: the roster client id the asset came from (the registry's lender) */
  register(id: string, assets: { top?: Blob | null; mesh?: Blob | null }, owner: string): boolean | void;
  unregister(id: string, owner: string): void;
}

const MIME: Record<VisualKind, string> = { top: 'image/png', mesh: 'model/gltf-binary' };

/** the lender name a relayed asset is registered under (never the editor's, which lends none) */
const lenderOf = (owner: string): string => `relay:${owner}`;

/** the renderers' own registry: where relayed assets go unless a check says otherwise */
const REGISTRY: RelayedAssetSink = {
  register: (id, assets, owner) => registerImportedAssets(id, assets, lenderOf(owner)),
  unregister: (id, owner) => unregisterImportedAssets(id, lenderOf(owner)),
};
let sink: RelayedAssetSink = REGISTRY;
/** what the relay has delivered and not yet given up: robot id → the owner it came from, and which kinds */
const held = new Map<string, { owner: string; top?: true; mesh?: true }>();

/** stand another sink in for the registry (a check), or null for the registry again */
export function setRelayedAssetSink(next: RelayedAssetSink | null): void {
  sink = next ?? REGISTRY;
}

/**
 * A validated asset arrived from `owner` for robot `id`. False when the id is already bound to
 * another owner (or the registry refused it): nothing is lent.
 */
export function registerRelayedAsset(owner: string, id: string, kind: VisualKind, bytes: Uint8Array): boolean {
  const cur = held.get(id);
  if (cur && cur.owner !== owner) return false;
  const blob = new Blob([bytes as BlobPart], { type: MIME[kind] });
  if (sink.register(id, { [kind]: blob }, owner) === false) return false;
  held.set(id, { ...(cur ?? { owner }), [kind]: true });
  return true;
}

/** has the relay already delivered this owner's asset for this robot on this device? */
export function hasRelayedAsset(owner: string, id: string, kind: VisualKind): boolean {
  const h = held.get(id);
  return !!h && h.owner === owner && !!h[kind];
}

/** is this robot id already bound to an owner other than `owner`? (its look came from them) */
export function relayedIdTakenByOther(owner: string, id: string): boolean {
  const h = held.get(id);
  return !!h && h.owner !== owner;
}

/** the relay is done with these robots (the room was left, or the viewer turned them off) */
export function unregisterRelayedAssets(ids: Iterable<string>): void {
  for (const id of [...ids]) {
    const h = held.get(id);
    if (!h) continue;
    held.delete(id);
    sink.unregister(id, h.owner);
  }
}

/** every robot id the relay is holding something for */
export function relayedAssetIds(): string[] {
  return [...held.keys()];
}
