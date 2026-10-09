import { useCallback, useSyncExternalStore } from 'react';
import { ANY_ID, importedAssetVersion, importedTopUrl, subscribeImportedAssets } from '../render/importedAssets';
import type { ImportedRobot } from '../types';

/**
 * REACT'S VIEW OF `render/importedAssets.ts`. A canvas in the match redraws every frame and simply
 * finds the picture when it lands; a builder preview draws once per React render, so it has to be
 * TOLD — these re-render the component when anything for `id` changes (a picture decoded, a draft
 * blob lent or replaced, the cache invalidated). `undefined` ids (a standard robot) never subscribe
 * to anything that fires.
 */
export function useImportedAssetVersion(id: string | undefined): number {
  const subscribe = useCallback(
    (onChange: () => void) =>
      subscribeImportedAssets((changed) => {
        if (id && (changed === id || changed === ANY_ID)) onChange();
      }),
    [id],
  );
  return useSyncExternalStore(
    subscribe,
    () => (id ? importedAssetVersion(id) : 0),
    () => 0,
  );
}

/** the import's top-down picture as an object URL (`importedTopUrl`), or null until it is ready */
export function useImportedTopUrl(id: string | undefined, imp?: ImportedRobot | null): string | null {
  useImportedAssetVersion(id);
  // with the robot being drawn, so an out-of-date library copy is not shown (`importedTopUrl`)
  return id ? importedTopUrl(id, imp) : null;
}
