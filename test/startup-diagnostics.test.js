const { test } = require("node:test");
const assert = require("node:assert/strict");
const { diagnose } = require("../startup-diagnostics");
test("startup diagnostics classify failures without exposing paths, tokens or raw errors", () => {
  const privateText =
    "private-token-NEVER-PUBLISH /private/hosting/account/database";
  for (const [error, code] of [
    [{ code: "EACCES", message: privateText }, "STORAGE_ACCESS_DENIED"],
    [{ code: "EPERM", message: privateText }, "STORAGE_ACCESS_DENIED"],
    [{ code: "EROFS", message: privateText }, "STORAGE_ACCESS_DENIED"],
    [{ code: "ENOSPC", message: privateText }, "STORAGE_FULL"],
    [
      { code: "ENOTDIR", message: privateText },
      "STORAGE_DIRECTORY_UNAVAILABLE",
    ],
    [
      { code: "MODULE_NOT_FOUND", message: privateText },
      "REQUIRED_MODULE_MISSING",
    ],
    [
      { code: "ERR_SQLITE_ERROR", message: privateText },
      "LOCAL_DATABASE_UNAVAILABLE",
    ],
    [
      {
        code: "ERR_UNKNOWN_BUILTIN_MODULE",
        message: "node:sqlite " + privateText,
      },
      "NODE_SQLITE_UNAVAILABLE",
    ],
    [
      { message: "Set SESSION_SECRET " + privateText },
      "SESSION_SECRET_REQUIRED",
    ],
    [{ message: "Set SETUP_KEY " + privateText }, "SETUP_KEY_REQUIRED"],
    [
      { message: "Supabase requires " + privateText },
      "SUPABASE_CREDENTIALS_REQUIRED",
    ],
    [
      { message: "Supabase query failed " + privateText },
      "SUPABASE_UNAVAILABLE",
    ],
    [
      { message: "DATA_DIR must be absolute " + privateText },
      "DATA_DIRECTORY_INVALID",
    ],
    [
      { message: "DATABASE_BACKEND must be valid " + privateText },
      "DATABASE_BACKEND_INVALID",
    ],
    [{ message: privateText }, "APPLICATION_STARTUP_FAILED"],
  ]) {
    const result = diagnose({ ...error, startupPhase: "session-storage" });
    assert.equal(result.code, code);
    assert.equal(result.phase, "session-storage");
    assert.ok(!JSON.stringify(result).includes(privateText));
    assert.ok(!JSON.stringify(result).includes("/private/hosting"));
  }
  assert.equal(diagnose({ startupPhase: privateText }).phase, "module-loading");
  assert.equal(diagnose(null).code, "APPLICATION_STARTUP_FAILED");
});
test("an invalid production storage directory exposes a safe code and initialization phase while keeping the demo available", async () => {
  const fs = require("node:fs"),
    os = require("node:os"),
    path = require("node:path"),
    { spawn } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawada-diagnostics-")),
    file = path.join(dir, "private-storage-file");
  fs.writeFileSync(file, "retained-data");
  const child = spawn(process.execPath, [path.resolve("server.js")], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_BACKEND: "sqlite",
      DATA_DIR: file,
      SESSION_SECRET: "diagnostic-only-test-secret-1234567890123456",
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", (b) => (logs += b));
  try {
    const base = await new Promise((resolve, reject) => {
      child.once("exit", () => reject(Error("Server exited")));
      child.stdout.on("data", (b) => {
        const match = String(b).match(/Delivery app listening (\d+)/);
        if (match) resolve("http://127.0.0.1:" + match[1]);
      });
    });
    const response = await fetch(base + "/api/setup"),
      body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.code, "STORAGE_DIRECTORY_UNAVAILABLE");
    assert.equal(body.phase, "database");
    assert.ok(!JSON.stringify(body).includes(dir));
    const ready = await fetch(base + "/health/ready");
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).phase, "database");
    assert.equal((await fetch(base + "/demo")).status, 200);
    assert.equal(fs.readFileSync(file, "utf8"), "retained-data");
    assert.ok(logs.includes("STORAGE_DIRECTORY_UNAVAILABLE"));
  } finally {
    if (child.exitCode === null) {
      const done = new Promise((r) => child.once("exit", r));
      child.kill();
      await done;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
