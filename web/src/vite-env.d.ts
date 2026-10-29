/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_VKIN_API_URL?: string;
  readonly VITE_GOOGLE_ENABLED?: string;
  readonly VITE_DOWNLOAD_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
