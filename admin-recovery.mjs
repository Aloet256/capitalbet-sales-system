import { createClient } from '@supabase/supabase-js';

export function supabaseClient(url, key) {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: (input, options) => fetch(input, { ...options, signal: AbortSignal.timeout(10_000) }) },
  });
}

export function createAdminAuth({ url, publishableKey, email, userId }) {
  if (!url || !publishableKey || !email || !userId) throw new Error('Complete the Supabase administrator setup before starting the server.');
  const client = () => supabaseClient(url, publishableKey).auth;
  const isAdmin = user => user?.id === userId && user.email?.toLowerCase() === email.toLowerCase();
  return {
    async signIn(password) {
      const { data, error } = await client().signInWithPassword({ email, password });
      if (error && (!error.status || error.status >= 500)) throw new Error('Supabase sign-in is temporarily unavailable.');
      return !error && isAdmin(data.user);
    },
    async sendCode() {
      const { error } = await client().resetPasswordForEmail(email);
      if (error) throw new Error('Supabase could not send the administrator recovery email.');
    },
    async verifyCode(token) {
      const auth = client();
      const { data, error } = await auth.verifyOtp({ email, token, type: 'recovery' });
      if (error && (!error.status || error.status >= 500)) throw new Error('Supabase recovery is temporarily unavailable.');
      return !error && isAdmin(data.user) && data.session ? auth : null;
    },
    async changePassword(auth, password) {
      const { data, error } = await auth.updateUser({ password });
      if (error && (!error.status || error.status >= 500)) throw new Error('Supabase password update is temporarily unavailable.');
      if (error || !isAdmin(data.user)) return false;
      await auth.signOut({ scope: 'local' });
      return true;
    },
  };
}
