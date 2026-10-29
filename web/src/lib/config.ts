// Only public values are read here, from web/.env.local at build/dev time. Never put a secret in a VITE_ variable.
export const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();
export const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

function validUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Returns the trimmed URL without trailing slashes, or '' when it is missing or not http(s). */
function httpUrlOrEmpty(raw: string | undefined): string {
  const u = (raw ?? '').trim().replace(/\/+$/, '');
  return validUrl(u) ? u : '';
}

/** False when the env vars are missing; the UI then shows the "Not configured yet" screen. */
export const isConfigured: boolean = validUrl(supabaseUrl) && supabaseAnonKey.length > 0;

/** Base URL of the hosted Vkin API (e.g. https://vkin-api.onrender.com). '' hides the minutes card. */
export const vkinApiUrl: string = httpUrlOrEmpty(import.meta.env.VITE_VKIN_API_URL);

/** "Continue with Google" is shown only when this is exactly '1' (the provider must be enabled in Supabase). */
export const googleEnabled: boolean = (import.meta.env.VITE_GOOGLE_ENABLED ?? '').trim() === '1';

/** Link to the Windows installer. '' keeps the "nothing to download yet" placeholder on the landing page. */
export const downloadUrl: string = httpUrlOrEmpty(import.meta.env.VITE_DOWNLOAD_URL);
