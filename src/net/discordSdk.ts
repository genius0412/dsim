/**
 * The Embedded App SDK's lazy facade — the ONLY module that names
 * `@discord/embedded-app-sdk`, and it is only ever DYNAMICALLY imported
 * (`watchDiscordParticipants`), so the SDK is a chunk nobody outside a Discord
 * Activity downloads.
 *
 * The facade exists for the CHUNK NAME, not for abstraction: Vite names a lazy
 * chunk after its facade module, and the SDK package's own entry is `index.js`,
 * so importing the package directly produced `index-<hash>.js` — which
 * `bundleaudit`'s filename-first routing reads as the MAIN chunk and bills
 * against main's baseline (+47.9 KB gzip, a fifth of the whole tolerance).
 * Through this file the chunk is `discordSdk-<hash>.js` and lands on the
 * audit's own `discord` route.
 */
export { DiscordSDK } from '@discord/embedded-app-sdk';
