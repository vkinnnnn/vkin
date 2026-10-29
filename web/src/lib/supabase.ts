import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isConfigured, supabaseAnonKey, supabaseUrl } from './config';

/** null when the env vars are missing. Only imported by the (lazy) signed-in part of the app. */
export const supabase: SupabaseClient | null = isConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        // The "vkin." prefix lets sign-out remove the session key together with the app's other keys.
        storageKey: 'vkin.auth',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
