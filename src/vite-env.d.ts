/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  /** new Supabase publishable key (sb_publishable_…) — client-safe */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** legacy anon key — still accepted as a fallback */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
