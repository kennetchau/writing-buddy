/**
 * All configuration comes from environment variables (backend doc §1/§6).
 * Read lazily so tests can set process.env before importing app code.
 */
export interface AppConfig {
  /** Port to listen on. */
  port: number;
  /** Postgres connection string. */
  databaseUrl: string;
  /** Random secret for signing the session cookie value. */
  sessionSecret: string;
  /** llama.cpp router base URL, e.g. http://host.containers.internal:21000/v1 */
  llamaUrl: string;
  /** LLM read timeout in seconds (the local model is slow — 900 default). */
  llmReadTimeout: number;
  /** Single flat directory for uploaded images (mounted volume in prod). */
  imagesDir: string;
  /**
   * Set the Secure flag on the session cookie. The deploy is HTTPS-only
   * (nginx terminates TLS), so prod sets COOKIE_SECURE=true; local HTTP dev
   * and the curl smoke suite leave it unset so the cookie still round-trips.
   */
  cookieSecure: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const portRaw = env.PORT ?? "9187";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got: ${portRaw}`);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required, e.g. postgres://user:pass@host:5432/db");
  }

  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET is required (any long random string)");
  }

  return {
    port,
    databaseUrl,
    sessionSecret,
    // Verified reachable from a rootless podman container on the deploy host
    // (old build); overridable via env if the llama.cpp address changes.
    llamaUrl: env.LLAMA_URL ?? "http://host.containers.internal:21000/v1",
    llmReadTimeout: Number.parseFloat(env.LLM_READ_TIMEOUT ?? "900"),
    imagesDir: env.IMAGES_DIR ?? "/images",
    cookieSecure: env.COOKIE_SECURE === "true",
  };
}
