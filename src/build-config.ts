// Build-time configuration injected by `scripts/inject-build-config.mjs`.
// Committed defaults are null so local dev / unit tests fall back to env vars.
// CI rewrites this file before `tsc` to bake in the real client ID and the
// API base URL appropriate for the flavor (test vs prod).
export const BUILDTIME_CLIENT_ID: string | null = null;
export const BUILDTIME_API_BASE_URL: string | null = null;
export const BUILD_FLAVOR: "dev" | "test" | "prod" = "dev";
