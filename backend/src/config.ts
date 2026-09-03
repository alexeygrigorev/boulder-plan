// Конфиг рантайма. Локально (без AUTH_*): auth выключен, API открыто.
// В AWS (с AUTH_*): вход только по JWT после shared-Cognito логина.
export interface AuthConfig {
  baseUrl: string;
  clientId: string;
  callbackUrl: string;
  logoutUrl: string;
  issuer: string;
  jwksUrl: string;
}

export interface AppConfig {
  tableName?: string;
  jwtSecret: string;
  auth?: AuthConfig;
  frontendBuild?: string;
}

const DEV_JWT_SECRET = "local-dev-only-secret-not-for-production-use-000000";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const tableName = env.TABLE_NAME?.trim() || undefined;
  const authValues = {
    baseUrl: env.AUTH_BASE_URL?.trim().replace(/\/$/, "") ?? "",
    clientId: env.AUTH_CLIENT_ID?.trim() ?? "",
    callbackUrl: env.AUTH_CALLBACK_URL?.trim() ?? "",
    logoutUrl: env.AUTH_LOGOUT_URL?.trim() ?? "",
    issuer: env.AUTH_ISSUER?.trim().replace(/\/$/, "") ?? "",
    jwksUrl: env.AUTH_JWKS_URL?.trim() ?? "",
  };
  const filled = Object.values(authValues).filter(Boolean);
  if (filled.length > 0 && filled.length !== Object.keys(authValues).length) {
    throw new Error("Shared auth configuration must be complete");
  }
  const auth = filled.length > 0 ? authValues : undefined;

  let jwtSecret = env.JWT_SECRET ?? "";
  if (auth) {
    if (jwtSecret.length < 50) throw new Error("JWT_SECRET must contain at least 50 characters");
  } else if (!jwtSecret) {
    jwtSecret = DEV_JWT_SECRET;
  }

  const frontendBuild = env.FRONTEND_BUILD?.trim() || undefined;
  return { tableName, jwtSecret, ...(auth ? { auth } : {}), ...(frontendBuild ? { frontendBuild } : {}) };
}

export function sharedAuthPublicConfig(auth: AuthConfig): Record<string, string> {
  return {
    base_url: auth.baseUrl,
    client_id: auth.clientId,
    callback_url: auth.callbackUrl,
    logout_url: auth.logoutUrl,
  };
}
