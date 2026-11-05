const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createStorage } = require("../storage");
test("driver chat isolates threads, enforces live assignments, preserves concurrent sends and tracks each reader", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawada-chat-"));
  const keys = ["DATA_DIR", "DATABASE_BACKEND", "NODE_ENV", "SESSION_SECRET"],
    original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    DATA_DIR: dir,
    DATABASE_BACKEND: "sqlite",
    NODE_ENV: "test",
    SESSION_SECRET: "chat-test-only-stable-secret-1234567890123456",
  });
  let server, inspect;
  try {
    const app = await require("../application").createApplication();
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = "http://127.0.0.1:" + server.address().port + "/api/";
    async function call(agent, route, body, expected = 200) {
      const r = await fetch(base + route, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          cookie: agent.cookie || "",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      assert.equal(r.status, expected, text);
      if (r.headers.get("set-cookie"))
        agent.cookie = r.headers.get("set-cookie").split(";")[0];
      return JSON.parse(text);
    }
    const admin = {},
      a = {},
      b = {},
      outsider = {},
      ops = {},
      warehouse = {},
      restricted = {},
      password = "chat-password-12345";
    await call(admin, "setup", {
      name: "Admin",
      email: "admin@example.test",
      password,
    });
    await call(admin, "login", { email: "admin@example.test", password });
    for (const [name, role, agent, permissions] of [
      ["a", "driver", a],
      ["b", "driver", b],
      ["outsider", "driver", outsider],
      ["ops", "operations", ops],
      ["warehouse", "warehouse", warehouse],
      ["restricted", "operations", restricted, []],
    ]) {
      await call(admin, "users", {
        name,
        role,
        email: name + "@example.test",
        password,
        ...(permissions ? { permissions } : {}),
      });
      await call(agent, "login", { email: name + "@example.test", password });
    }
    const users = (await call(admin, "state")).users,
      id = (name) => users.find((u) => u.name === name).id;
    await call(admin, "vendors", {
      code: "V",
      name: "Vendor",
      address: "Kuwait",
    });
    const order = await call(admin, "orders", {
      reference: "CHAT",
      recipient: "Customer",
      address: "Kuwait",
      phone: "+96555555555",
      items: [{ vendorCode: "V", name: "Gift", quantity: 1 }],
    });
    const action = "orders/" + order.id + "/action";
    await call(admin, action, { action: "assign", driver: id("a") });
    await call(admin, action, {
      action: "assign-pickup",
      driver: id("b"),
      pickup: order.pickups[0].id,
    });
    const thread = "chat/" + order.id + "/" + id("a"),
      otherThread = "chat/" + order.id + "/" + id("b");
    await call({}, "chat/inbox", null, 401);
    await call(warehouse, "chat/inbox", null, 403);
    await call(restricted, "chat/inbox", null, 403);
    await call(outsider, thread, null, 404);
    await call(b, thread, null, 404);
    await call(a, otherThread, null, 404);
    const body = {
      body: "Please confirm the delivery entrance.",
      clientId: crypto.randomUUID(),
      senderId: "spoof",
      senderRole: "driver",
    };
    const message = await call(admin, thread + "/messages", body);
    assert.equal(message.senderRole, "admin");
    assert.notEqual(message.senderId, "spoof");
    const repeated = await call(admin, thread + "/messages", body);
    assert.equal(repeated.id, message.id);
    await call(
      admin,
      thread + "/messages",
      { ...body, body: "Different" },
      409,
    );
    await call(
      admin,
      thread + "/messages",
      { body: "   ", clientId: crypto.randomUUID() },
      400,
    );
    await call(
      admin,
      thread + "/messages",
      { body: "x".repeat(2001), clientId: crypto.randomUUID() },
      400,
    );
    assert.equal((await call(a, "chat/inbox")).unread, 1);
    await call(a, thread);
    assert.equal(
      (await call(a, "chat/inbox")).unread,
      1,
      "GET must not mark hidden messages read",
    );
    await call(a, thread + "/read", { through: 1 });
    assert.equal((await call(a, "chat/inbox")).unread, 0);
    const simultaneous = await Promise.all([
      call(a, thread + "/messages", {
        body: "Entrance confirmed",
        clientId: crypto.randomUUID(),
      }),
      call(admin, thread + "/messages", {
        body: "Thank you",
        clientId: crypto.randomUUID(),
      }),
    ]);
    assert.equal(new Set(simultaneous.map((m) => m.seq)).size, 2);
    assert.equal((await call(a, thread)).messages.length, 3);
    assert.equal((await call(admin, "chat/inbox")).unread, 1);
    assert.equal((await call(ops, "chat/inbox")).unread, 3);
    await call(admin, thread + "/read", { through: 3 });
    assert.equal((await call(admin, "chat/inbox")).unread, 0);
    assert.equal(
      (await call(ops, "chat/inbox")).unread,
      3,
      "one operator must not clear another operator’s unread count",
    );
    assert.equal((await call(b, "chat/inbox")).unread, 0);
    assert.equal((await call(b, otherThread)).messages.length, 0);
    await call(a, thread + "/read", { through: 999 }, 400);
    assert.equal((await call(a, "state")).orders[0].driverChats, undefined);
    const changed = await call(admin, action, {
      action: "assign",
      driver: id("a"),
    });
    assert.equal(changed.driverChats, undefined);
    // Saved history supports bounded pages and survives assignment revocation without leaking to a replacement driver.
    inspect = createStorage({ DATA_DIR: dir });
    let saved = await inspect.get("orders", order.id),
      existing = saved.driverChats[id("a")];
    for (let seq = 4; seq <= 105; seq++)
      existing.messages.push({
        ...message,
        id: crypto.randomUUID(),
        clientId: crypto.randomUUID(),
        seq,
        body: "History " + seq,
      });
    await inspect.save("orders", saved);
    const page = await call(a, thread);
    assert.equal(page.messages.length, 100);
    assert.equal(page.messages[0].seq, 6);
    assert.equal(page.hasEarlier, true);
    assert.equal((await call(a, thread + "?before=6")).messages.length, 5);
    await call(admin, action, { action: "assign", driver: id("outsider") });
    await call(a, thread, null, 404);
    await call(
      a,
      thread + "/messages",
      { body: "Old driver", clientId: crypto.randomUUID() },
      404,
    );
    assert.equal((await call(a, "chat/inbox")).rows.length, 0);
    await call(outsider, thread, null, 404);
    assert.equal(
      (await call(outsider, "chat/" + order.id + "/" + id("outsider"))).messages
        .length,
      0,
    );
    await call(admin, action, { action: "assign", driver: id("a") });
    assert.equal((await call(a, thread)).latest, 105);
    saved = await inspect.get("orders", order.id);
    existing = saved.driverChats[id("a")];
    for (let seq = 106; seq <= 1000; seq++)
      existing.messages.push({
        ...message,
        id: crypto.randomUUID(),
        clientId: crypto.randomUUID(),
        seq,
      });
    await inspect.save("orders", saved);
    await call(
      a,
      thread + "/messages",
      { body: "Beyond limit", clientId: crypto.randomUUID() },
      409,
    );
    assert.equal(
      (await call(a, thread)).latest,
      1000,
      "history must not be silently truncated",
    );
  } finally {
    inspect?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    for (const k of keys)
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
