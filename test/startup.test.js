const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
test(
  "configuration failure keeps diagnostics and isolated demo available without bypassing account protection",
  { timeout: 60000 },
  async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-startup-"));
    const child = spawn(process.execPath, [path.resolve("server.js")], {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: "production",
        SESSION_SECRET: "",
        DATABASE_BACKEND: "sqlite",
        DATA_DIR: path.join(cwd, "data"),
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const url = await new Promise((resolve, reject) => {
        child.once("exit", () => reject(Error("Unexpected server exit")));
        child.stdout.on("data", (b) => {
          const m = String(b).match(/Delivery app listening (\d+)/);
          if (m) resolve("http://127.0.0.1:" + m[1]);
        });
      });
      const health = await fetch(url + "/health/ready");
      assert.equal(health.status, 503);
      const setup = await fetch(url + "/api/setup");
      assert.equal(setup.status, 503);
      const diagnostic = await setup.json();
      assert.equal(diagnostic.code, "SESSION_SECRET_REQUIRED");
      assert.equal(diagnostic.phase, "configuration");
      assert.equal((await fetch(url + "/health/live")).status, 200);
      assert.equal((await fetch(url + "/demo")).status, 200);
      assert.equal((await fetch(url + "/driver")).status, 200);
      assert.equal((await fetch(url + "/demo.js")).status, 200);
      const attempted = await fetch(url + "/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "unauthorized",
          email: "nobody@example.test",
          password: "not-a-real-password",
        }),
      });
      assert.equal(attempted.status, 503);
      const root = await fetch(url + "/").then((r) => r.text());
      assert.ok(root.includes("/demo.js"));
      assert.ok(root.includes("Suggest an improvement"));
      const label = await fetch(url + "/demo/barcode/DEMO-KW-1001");
      assert.equal(label.status, 200);
      assert.equal(label.headers.get("content-type"), "image/png");
      assert.equal((await fetch(url + "/demo/barcode/REAL-ORDER")).status, 400);
    } finally {
      const done = new Promise((r) => child.once("exit", r));
      child.kill();
      await done;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);
