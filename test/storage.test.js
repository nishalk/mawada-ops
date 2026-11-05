const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createClient } = require("@supabase/supabase-js");
const { createStorage } = require("../storage");
test("SQLite storage rejects stale writes and rolls back a failed batch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-store-"));
  const s = createStorage({ DATA_DIR: dir });
  try {
    await s.save("orders", { id: "one", status: "Created" });
    const a = await s.get("orders", "one"),
      b = await s.get("orders", "one");
    await s.save("orders", { ...a, status: "Picked up" });
    await assert.rejects(
      s.save("orders", { ...b, status: "Delivered" }),
      (e) => e.status === 409,
    );
    await assert.rejects(
      s.insertMany("orders", [{ id: "two" }, { id: "one" }]),
    );
    assert.equal(await s.get("orders", "two"), undefined);
    assert.equal((await s.get("orders", "one")).status, "Picked up");
  } finally {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Supabase rejects anonymous keys and does not silently fall back", () => {
  assert.throws(
    () =>
      createStorage({
        DATABASE_BACKEND: "supabase",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_API_KEY: "sb_publishable_test",
      }),
    /server-only/,
  );
  assert.throws(
    () => createStorage({ DATABASE_BACKEND: "unknown" }),
    /DATABASE_BACKEND/,
  );
});
test("Supabase SDK adapter reads all pages, saves with revisions, and atomically inserts batches", async () => {
  const rows = new Map();
  let sawServerCredential = false,
    sawCompactWriteResponse = false;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    sawServerCredential ||=
      req.headers.authorization === "Bearer sb_secret_test_fixture_only";
    res.setHeader("Content-Type", "application/json");
    const kind = u.searchParams.get("kind")?.replace(/^eq\./, "");
    const id = u.searchParams.get("id")?.replace(/^eq\./, "");
    const rev = u.searchParams.get("revision")?.replace(/^eq\./, "");
    let selected = [...rows.values()]
      .filter(
        (r) =>
          (!kind || r.kind === kind) &&
          (!id || r.id === id) &&
          (rev === undefined || r.revision === Number(rev)),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    if (req.method === "GET") {
      const start = Number(u.searchParams.get("offset") || 0),
        end = start + Number(u.searchParams.get("limit") || 1000);
      res.end(JSON.stringify(selected.slice(start, end)));
      return;
    }
    let text = "";
    for await (const c of req) text += c;
    const body = JSON.parse(text);
    if (
      ["POST", "PATCH"].includes(req.method) &&
      u.searchParams.get("select") === "revision"
    )
      sawCompactWriteResponse = true;
    const project = (rows) =>
      u.searchParams.get("select") === "revision"
        ? rows.map((r) => ({ revision: r.revision }))
        : rows;
    if (req.method === "POST") {
      const batch = Array.isArray(body) ? body : [body];
      if (
        batch.some((r) => rows.has(r.kind + ":" + r.id)) ||
        new Set(batch.map((r) => r.kind + ":" + r.id)).size !== batch.length
      ) {
        res.statusCode = 409;
        res.end(JSON.stringify({ code: "23505", message: "duplicate" }));
        return;
      }
      const saved = batch.map((r) => ({ ...r, revision: 1 }));
      saved.forEach((r) => rows.set(r.kind + ":" + r.id, r));
      res.statusCode = 201;
      res.end(JSON.stringify(project(saved)));
      return;
    }
    if (req.method === "PATCH") {
      selected = selected.map((r) => ({ ...r, ...body }));
      selected.forEach((r) => rows.set(r.kind + ":" + r.id, r));
      res.end(JSON.stringify(project(selected)));
      return;
    }
    res.statusCode = 405;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const client = createClient(
    "http://127.0.0.1:" + server.address().port,
    "sb_secret_test_fixture_only",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const s = createStorage(
    {
      DATABASE_BACKEND: "supabase",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_API_KEY: "sb_secret_test_fixture_only",
    },
    client,
  );
  try {
    await s.insertMany(
      "orders",
      Array.from({ length: 205 }, (_, i) => ({
        id: String(i).padStart(3, "0"),
        status: "Created",
      })),
    );
    assert.equal((await s.all("orders")).length, 205);
    const a = await s.get("orders", "001"),
      b = await s.get("orders", "001");
    assert.equal(a._revision, 1);
    await s.save("orders", { ...a, status: "Picked up" });
    await assert.rejects(
      s.save("orders", { ...b, status: "Delivered" }),
      (e) => e.status === 409,
    );
    await assert.rejects(
      s.insertMany("orders", [{ id: "new" }, { id: "001" }]),
      (e) => e.status === 409,
    );
    assert.equal(await s.get("orders", "new"), undefined);
    assert.equal((await s.get("orders", "001")).status, "Picked up");
    assert.equal(sawServerCredential, true);
    assert.equal(sawCompactWriteResponse, true);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
