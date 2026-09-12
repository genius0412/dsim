import { useSyncExternalStore } from 'react';
import { lanEnabled, subscribeLanEnabled } from '../net/env';

/**
 * Are the LAN entry points on? Re-renders if the answer arrives after this component did.
 *
 * `lanEnabled()` is the build flag OR'd with what the server advertised, and the server's
 * half arrives one cached fetch after the app starts — so a component that read it as a
 * plain value at mount would show the old answer forever. This is the whole reason it is a
 * hook now and not the `LAN_ENABLED` const it used to be.
 *
 * `useSyncExternalStore` rather than state + effect because the value lives outside React
 * already (a module-level flag shared with `parseScreen`, which is not a component and
 * cannot hold hooks). The snapshot is a boolean, so an unchanged answer is referentially
 * equal and costs no re-render; the flip happens at most once per page.
 */
export function useLanEnabled(): boolean {
  return useSyncExternalStore(subscribeLanEnabled, lanEnabled, lanEnabled);
}
