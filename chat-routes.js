const crypto = require("node:crypto");
const access = require("./public/access");
const assigned = (order, id) =>
  order.driver === id || (order.pickups || []).some((p) => p.driver === id);
const permitted = (user) =>
  ["admin", "operations", "driver"].includes(user.role) &&
  access.allowed(user, "work");
const unread = (thread, userId) =>
  (thread?.messages || []).filter(
    (m) => m.senderId !== userId && m.seq > (thread.read?.[userId] || 0),
  ).length;
module.exports = function install(app, store, runtime) {
  app.use("/api/chat", (q, r, next) =>
    permitted(q.user)
      ? next()
      : r.status(403).json({
          error: "Driver chat requires operations or driver workflow access",
        }),
  );
  async function context(user, orderId, driverId) {
    const order = await store.get("orders", orderId),
      driver = await store.get("users", driverId);
    if (
      !order ||
      order.demoData ||
      !driver ||
      driver.deletedAt ||
      driver.role !== "driver" ||
      !access.allowed(driver, "work") ||
      !assigned(order, driverId) ||
      (user.role === "driver" && user.id !== driverId)
    )
      throw Object.assign(
        Error("This driver conversation is not available to your account"),
        { status: 404 },
      );
    return {
      order,
      driver,
      thread: order.driverChats?.[driverId] || { messages: [], read: {} },
    };
  }
  // Retry only revision conflicts, rechecking assignment on every attempt.
  async function write(q, mutate) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const c = await context(q.user, q.params.orderId, q.params.driverId);
      const result = mutate(c.thread);
      if (result.unchanged) return result.value;
      (c.order.driverChats ||= {})[c.driver.id] = c.thread;
      try {
        await store.save("orders", c.order);
        return result.value;
      } catch (e) {
        if (e.status !== 409 || attempt === 2) throw e;
      }
    }
  }
  app.get("/api/chat/inbox", async (q, r) => {
    const drivers = (await store.all("users")).filter(
      (u) =>
        !u.deletedAt &&
        u.role === "driver" &&
        access.allowed(u, "work") &&
        (q.user.role !== "driver" || u.id === q.user.id),
    );
    const rows = [];
    for (const o of await store.all("orders")) {
      if (o.demoData) continue;
      const ids = new Set(
        [o.driver, ...(o.pickups || []).map((p) => p.driver)].filter(Boolean),
      );
      for (const driver of drivers.filter((d) => ids.has(d.id))) {
        const thread = o.driverChats?.[driver.id],
          last = thread?.messages.at(-1);
        rows.push({
          orderId: o.id,
          driverId: driver.id,
          driverName: driver.name,
          awb: o.awb,
          reference: o.reference,
          orderStatus: o.status,
          unread: unread(thread, q.user.id),
          preview: last?.body || "Start a conversation",
          lastAt: last?.at || null,
        });
      }
    }
    rows.sort(
      (a, b) =>
        Number(b.unread > 0) - Number(a.unread > 0) ||
        (b.lastAt || "").localeCompare(a.lastAt || "") ||
        a.awb.localeCompare(b.awb),
    );
    r.json({ rows, unread: rows.reduce((n, t) => n + t.unread, 0) });
  });
  app.get("/api/chat/:orderId/:driverId", async (q, r) => {
    const c = await context(q.user, q.params.orderId, q.params.driverId);
    const before =
      q.query.before === undefined ? Infinity : Number(q.query.before);
    if (before !== Infinity && (!Number.isSafeInteger(before) || before < 1))
      return r.status(400).json({ error: "Invalid message cursor" });
    const older = c.thread.messages.filter((m) => m.seq < before),
      messages = older.slice(-100);
    r.json({
      orderId: c.order.id,
      driverId: c.driver.id,
      driverName: c.driver.name,
      awb: c.order.awb,
      messages,
      hasEarlier: older.length > messages.length,
      latest: c.thread.messages.at(-1)?.seq || 0,
    });
  });
  app.post(
    "/api/chat/:orderId/:driverId/messages",
    runtime.limiter("chat-send", 120, 60000),
    async (q, r) => {
      const body = typeof q.body.body === "string" ? q.body.body.trim() : "",
        clientId = q.body.clientId;
      if (
        !body ||
        body.length > 2000 ||
        typeof clientId !== "string" ||
        !/^[A-Za-z0-9_-]{16,80}$/.test(clientId)
      )
        return r.status(400).json({
          error:
            "Enter a message of 1–2000 characters and a valid send identifier",
        });
      r.json(
        await write(q, (thread) => {
          const duplicate = thread.messages.find(
            (m) => m.clientId === clientId && m.senderId === q.user.id,
          );
          if (duplicate) {
            if (duplicate.body !== body)
              throw Object.assign(
                Error(
                  "This send identifier was already used for another message",
                ),
                { status: 409 },
              );
            return { unchanged: true, value: duplicate };
          }
          if (thread.messages.length >= 1000)
            throw Object.assign(
              Error(
                "This conversation has reached its 1000-message limit. Contact your administrator.",
              ),
              { status: 409 },
            );
          const message = {
            id: crypto.randomUUID(),
            seq: (thread.messages.at(-1)?.seq || 0) + 1,
            clientId,
            body,
            senderId: q.user.id,
            senderName: q.user.name,
            senderRole: q.user.role,
            at: new Date().toISOString(),
          };
          thread.messages.push(message);
          return { value: message };
        }),
      );
    },
  );
  app.post("/api/chat/:orderId/:driverId/read", async (q, r) => {
    if (!Number.isSafeInteger(q.body.through) || q.body.through < 0)
      return r
        .status(400)
        .json({ error: "A valid last-seen message number is required" });
    r.json(
      await write(q, (thread) => {
        if (q.body.through > (thread.messages.at(-1)?.seq || 0))
          throw Object.assign(
            Error("Refresh the conversation before marking messages read"),
            { status: 400 },
          );
        const through = Math.max(thread.read[q.user.id] || 0, q.body.through);
        const unchanged = through === (thread.read[q.user.id] || 0);
        thread.read[q.user.id] = through;
        return { unchanged, value: { ok: true } };
      }),
    );
  });
};
