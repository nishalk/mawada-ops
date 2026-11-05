const phases = new Set([
  "module-loading",
  "database",
  "configuration",
  "session-storage",
  "routes",
  "order-migration",
  "backup-scheduler",
]);
function diagnose(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  const phase = phases.has(error?.startupPhase)
    ? error.startupPhase
    : "module-loading";
  const result = (code, text) => ({ code, message: text, phase });
  if (message.includes("SESSION_SECRET"))
    return result(
      "SESSION_SECRET_REQUIRED",
      "Configure SESSION_SECRET in hosting settings with at least 32 random characters.",
    );
  if (message.includes("SETUP_KEY"))
    return result(
      "SETUP_KEY_REQUIRED",
      "Configure SETUP_KEY in hosting settings before creating the first administrator.",
    );
  if (message.includes("Supabase requires"))
    return result(
      "SUPABASE_CREDENTIALS_REQUIRED",
      "Configure SUPABASE_URL and a server-only Supabase service-role or secret key in hosting settings.",
    );
  if (message.includes("Supabase") || message.includes("fetch failed"))
    return result(
      "SUPABASE_UNAVAILABLE",
      "The cloud database could not be reached or queried. Check the project, existing database schema and server credentials.",
    );
  if (
    error?.code === "ERR_UNKNOWN_BUILTIN_MODULE" &&
    message.includes("sqlite")
  )
    return result(
      "NODE_SQLITE_UNAVAILABLE",
      "The running Node.js version does not provide SQLite support. Select Node.js 24 for the application runtime.",
    );
  if (["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(error?.code))
    return result(
      "REQUIRED_MODULE_MISSING",
      "A required server module is missing. Redeploy the complete repository and install its production dependencies.",
    );
  if (message.includes("DATA_DIR must be"))
    return result(
      "DATA_DIRECTORY_INVALID",
      "DATA_DIR must be an absolute writable directory confirmed by the hosting provider.",
    );
  if (message.includes("DATABASE_BACKEND must be"))
    return result(
      "DATABASE_BACKEND_INVALID",
      "DATABASE_BACKEND must be sqlite or supabase.",
    );
  if (["EACCES", "EPERM", "EROFS"].includes(error?.code))
    return result(
      "STORAGE_ACCESS_DENIED",
      "The app cannot create or secure its database/session files. Check persistent directory ownership, write permissions and filesystem support. No alternate storage was selected.",
    );
  if (["ENOTDIR", "EEXIST", "ENOENT"].includes(error?.code))
    return result(
      "STORAGE_DIRECTORY_UNAVAILABLE",
      "A required storage directory is missing or conflicts with a file. Check the configured persistent directory and mounted volume.",
    );
  if (error?.code === "ENOSPC")
    return result(
      "STORAGE_FULL",
      "The hosting storage is full. Restore free space before restarting the app.",
    );
  if (
    error?.code === "ERR_SQLITE_ERROR" ||
    String(error?.code || "").startsWith("SQLITE_")
  )
    return result(
      "LOCAL_DATABASE_UNAVAILABLE",
      "The local database or session database could not open or initialize. Check storage access, available space and database health; preserve existing files.",
    );
  return result(
    "APPLICATION_STARTUP_FAILED",
    "The application could not initialize. Share the error code and initialization step with your administrator; the detailed error remains in runtime logs.",
  );
}
module.exports = { diagnose };
