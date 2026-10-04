/**
 * Non-secret bindings are generated into Env by `wrangler types`.
 *
 * Wrangler secrets intentionally do not appear in wrangler.jsonc. These two
 * optional properties document the secret-backed TURN integration without
 * replacing or duplicating the generated binding types.
 */
export type RuntimeEnv = Omit<Env, "ALLOW_NO_ORIGIN" | "ENVIRONMENT"> & {
  ABUSE_ID_SECRET: string;
  ADMIN_TOKEN: string;
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
  ALLOW_NO_ORIGIN: string;
  ENVIRONMENT: string;
  ROOM_ID_SECRET: string;
  TURN_KEY_ID?: string;
  TURN_KEY_SECRET?: string;
  TURNSTILE_SECRET: string;
  TURNSTILE_TEST_BYPASS?: string;
};
