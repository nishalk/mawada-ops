const crypto = require("node:crypto"),
  bcrypt = require("bcryptjs");
const rules = require("./public/control"),
  access = require("./public/access"),
  trips = require("./public/operations");
const { hash, validPassword } = require("./reliability");
const updates = require("./customer-updates");
const { deliveryDay } = require("./mawada-import");
const publicUser = ({ password, reset, ...user }) => user;
const publicOrder = ({
  trackingTokens,
  customerUpdates,
  driverChats,
  ...order
}) => order;
function installPublic(app, store, runtime) {
  app.post(
    "/api/recovery/request",
    runtime.limiter("recovery", 5, 900000),
    async (q, r) => {
      const user = (await store.all("users")).find(
        (u) =>
          !u.deletedAt &&
          u.email ===
            String(q.body.email || "")
              .trim()
              .toLowerCase(),
      );
      if (user) {
        const token = crypto.randomBytes(32).toString("base64url");
        const saved = await store.save("users", {
          ...user,
          reset: { hash: hash(token), expires: Date.now() + 1800000 },
        });
        try {
          await updates.sendRecovery(user.email, token);
        } catch {
          // Never disclose account existence or provider errors to unauthenticated callers.
          try {
            await store.save("users", { ...saved, reset: null });
          } catch {}
        }
      }
      r.json({
        ok: true,
        message:
          "If this account exists and email recovery is configured, a reset link will arrive shortly. Contact your administrator if it does not arrive.",
      });
    },
  );
  app.post(
    "/api/recovery/reset",
    runtime.limiter("reset", 10, 900000),
    async (q, r) => {
      if (
        typeof q.body.token !== "string" ||
        q.body.token.length !== 43 ||
        !validPassword(q.body.password)
      )
        return r.status(400).json({
          error: "Valid reset link and password of 12–72 characters required",
        });
      const user = (await store.all("users")).find(
        (u) =>
          !u.deletedAt &&
          u.reset?.hash === hash(q.body.token) &&
          u.reset.expires > Date.now(),
      );
      if (!user)
        return r
          .status(400)
          .json({ error: "Reset link is invalid, expired or already used" });
      user.password = bcrypt.hashSync(q.body.password, 12);
      user.reset = null;
      user.authVersion = (user.authVersion || 0) + 1;
      user.accountHistory = [
        ...(user.accountHistory || []),
        { event: "Password reset by email link", at: new Date().toISOString() },
      ].slice(-100);
      await store.save("users", user);
      r.json({ ok: true });
    },
  );
  app.get(
    "/api/tracking/:token",
    runtime.limiter("tracking", 120, 60000),
    async (q, r) => {
      r.set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
      });
      if (!/^[A-Za-z0-9_-]{43}$/.test(q.params.token))
        return r
          .status(404)
          .json({ error: "Tracking link is invalid or expired" });
      const digest = hash(q.params.token);
      const order = (await store.all("orders")).find(
        (o) =>
          !o.demoData &&
          o.trackingTokens?.some(
            (t) => t.hash === digest && t.expires > Date.now(),
          ),
      );
      if (!order)
        return r.status(404).json({
          error:
            "Tracking link is invalid or expired. Contact Mawada for an update.",
        });
      r.json({
        awb: order.awb,
        status: order.status,
        deliveryDate: order.deliveryDate || null,
        timeSlot: order.timeSlot || null,
        updatedAt: order.history?.at(-1)?.at,
      });
    },
  );
}
function install(app, store, permit, runtime) {
  const guard = (permission) => [
    permit("admin", "operations"),
    (q, r, next) =>
      access.allowed(q.user, permission)
        ? next()
        : r.status(403).json({ error: "Access denied" }),
  ];
  app.post(
    "/api/control/pickups/:orderId/:pickupId",
    ...guard("work"),
    async (q, r) => {
      const o = await store.get("orders", q.params.orderId);
      const pickup = o?.pickups?.find((p) => p.id === q.params.pickupId);
      const due = Date.parse(q.body.dueAt);
      if (
        !o ||
        o.demoData ||
        !pickup ||
        pickup.completed ||
        !["Created", "Picked up"].includes(o.status)
      )
        return r.status(409).json({
          error: "Choose an incomplete vendor pickup before dispatch",
        });
      if (!Number.isFinite(due) || due <= Date.now())
        return r
          .status(400)
          .json({ error: "Choose a future pickup deadline in Kuwait time" });
      pickup.dueAt = new Date(due).toISOString();
      o.history.push({
        event: "Pickup deadline agreed",
        pickup: pickup.id,
        dueAt: pickup.dueAt,
        by: q.user.name,
        at: new Date().toISOString(),
      });
      await store.save("orders", o);
      r.json({ ok: true });
    },
  );
  app.get("/api/control", ...guard("dashboard"), async (q, r) => {
    const orders = await store.all("orders"),
      users = await store.all("users");
    r.json({
      at: new Date().toISOString(),
      exceptions: rules.exceptions(orders, users),
      drivers: users
        .filter((u) => !u.deletedAt && u.role === "driver")
        .map((u) => ({
          id: u.id,
          name: u.name,
          ...rules.workload(orders, u.id),
        })),
    });
  });
  app.post("/api/control/review", ...guard("work"), async (q, r) => {
    const o = await store.get("orders", q.body.orderId);
    if (!o || o.demoData)
      return r.status(404).json({ error: "Operational order required" });
    const active = rules
      .exceptions(await store.all("orders"), await store.all("users"))
      .find((e) => e.id === q.body.exceptionId && e.orderId === o.id);
    if (!active)
      return r
        .status(409)
        .json({ error: "Exception has changed. Refresh the queue." });
    const due = Date.parse(q.body.followUpAt),
      note = String(q.body.note || "").trim(),
      owner = String(q.body.owner || "").trim();
    if (
      !note ||
      note.length > 1000 ||
      !owner ||
      owner.length > 100 ||
      !Number.isFinite(due) ||
      due <= Date.now() ||
      due > Date.now() + 7 * 86400000
    )
      return r.status(400).json({
        error:
          "Owner, note and a follow-up within the next seven days required",
      });
    const key = active.id.slice(o.id.length + 1),
      review = {
        owner,
        note,
        followUpAt: new Date(due).toISOString(),
        by: q.user.name,
        at: new Date().toISOString(),
      };
    (o.exceptionReviews ||= {})[key] = review;
    o.history.push({ event: "Exception recovery plan", code: key, ...review });
    await store.save("orders", o);
    r.json({ ok: true });
  });
  app.get("/api/control/performance", ...guard("reports"), async (q, r) => {
    const from = deliveryDay(q.query.from) || rules.day(),
      to = deliveryDay(q.query.to) || rules.day();
    if (from > to)
      return r.status(400).json({ error: "Start date must precede end date" });
    r.json({
      from,
      to,
      ...rules.performance(await store.all("orders"), from, to),
    });
  });
  app.post("/api/control/bulk", ...guard("work"), async (q, r) => {
    const { driverId, leg, selections, confirm } = q.body;
    const driver = await store.get("users", driverId);
    if (
      !driver ||
      driver.deletedAt ||
      driver.role !== "driver" ||
      !["delivery", "pickup"].includes(leg) ||
      !Array.isArray(selections) ||
      !selections.length ||
      selections.length > 100 ||
      new Set(selections.map((s) => s.id)).size !== selections.length
    )
      return r
        .status(400)
        .json({ error: "Choose a driver, leg and 1–100 distinct orders" });
    const all = await store.all("orders"),
      plan = [];
    for (const s of selections) {
      const o = all.find((o) => o.id === s.id);
      if (
        !o ||
        o.demoData ||
        o._revision !== s.revision ||
        ["Delivered", "Out for delivery", "Delivery failed"].includes(o.status)
      )
        return r.status(409).json({
          error:
            "An order changed or cannot be assigned. Refresh and preview again.",
        });
      const pickups = (o.pickups || []).filter((p) => !p.completed);
      if (
        leg === "pickup" &&
        (!pickups.length ||
          trips.activeTrips(o).some((t) => t.kind === "pickup"))
      )
        return r.status(409).json({
          error:
            "Pickup orders must have incomplete pickups and no active pickup trip",
        });
      plan.push({ o, pickups });
    }
    const workload = rules.workload(all, driverId);
    const additional =
      leg === "delivery"
        ? plan.filter(({ o }) => o.driver !== driverId).length
        : plan.reduce(
            (n, { pickups }) =>
              n + pickups.filter((p) => p.driver !== driverId).length,
            0,
          );
    const preview = {
      driver: driver.name,
      workload,
      additional,
      projected: workload.deliveries + workload.pickups + additional,
      orders: plan.map(({ o, pickups }) => ({
        id: o.id,
        awb: o.awb,
        area: o.area || "Unspecified",
        window: o.timeSlot || "Unknown",
        date: o.deliveryDate || "Unscheduled",
        replacing:
          leg === "delivery"
            ? Boolean(o.driver && o.driver !== driverId)
            : pickups.some((p) => p.driver && p.driver !== driverId),
        count: leg === "delivery" ? 1 : pickups.length,
      })),
    };
    if (!confirm) return r.json(preview);
    const results = [];
    for (const { o, pickups } of plan) {
      if (leg === "delivery") o.driver = driverId;
      else for (const p of pickups) p.driver = driverId;
      o.history.push({
        event: "Bulk " + leg + " assignment",
        by: q.user.name,
        actorId: q.user.id,
        driverId,
        at: new Date().toISOString(),
      });
      if (leg === "delivery") updates.queueUpdate(o, "assign", q.user.id);
      try {
        await store.save("orders", o);
        results.push({ id: o.id, awb: o.awb, ok: true });
      } catch {
        results.push({
          id: o.id,
          awb: o.awb,
          ok: false,
          error:
            "Record changed or storage unavailable. Refresh and retry this order.",
        });
      }
    }
    r.json({ ...preview, results, partial: results.some((r) => !r.ok) });
  });
  app.post("/api/control/orders/:id/plan", ...guard("work"), async (q, r) => {
    const o = await store.get("orders", q.params.id);
    if (
      !o ||
      o.demoData ||
      ["Delivered", "Out for delivery", "Delivery failed"].includes(o.status)
    )
      return r.status(409).json({
        error:
          "Plan an order before dispatch; failed orders must use warehouse return and rescheduling",
      });
    const date = deliveryDay(q.body.deliveryDate);
    if (
      !date ||
      date < rules.day() ||
      !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(
        q.body.timeSlot || "",
      ) ||
      q.body.timeSlot.slice(0, 5) >= q.body.timeSlot.slice(6) ||
      String(q.body.area || "").length > 100
    )
      return r.status(400).json({
        error:
          "Choose today or later and a same-day window such as 09:00-12:00",
      });
    delete o.deliveryDueAt;
    Object.assign(o, {
      deliveryDate: date,
      timeSlot: q.body.timeSlot,
      area: String(q.body.area || "").trim(),
      whatsappConsent: q.body.whatsappConsent === true,
    });
    o.history.push({
      event: "Delivery plan updated",
      by: q.user.name,
      at: new Date().toISOString(),
      date,
      timeSlot: o.timeSlot,
      area: o.area,
      whatsappConsent: o.whatsappConsent,
    });
    await store.save("orders", o);
    r.json({ ok: true });
  });
  app.get("/api/control/updates", ...guard("work"), async (q, r) => {
    r.json({
      configured: updates.whatsappConfigured(),
      publicOrigin: updates.origin(),
      rows: (await store.all("orders"))
        .filter((o) => !o.demoData)
        .flatMap((o) =>
          (o.customerUpdates || []).map((u) => ({
            ...u,
            orderId: o.id,
            awb: o.awb,
          })),
        )
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 500),
    });
  });
  app.post(
    "/api/control/orders/:id/tracking",
    ...guard("work"),
    async (q, r) => {
      const o = await store.get("orders", q.params.id);
      if (!o || o.demoData)
        return r.status(404).json({ error: "Operational order required" });
      if (q.body.revoke) {
        o.trackingTokens = [];
        for (const u of o.customerUpdates || [])
          if (u.status === "Queued") u.status = "Cancelled";
      }
      const result = q.body.revoke ? { ok: true } : updates.trackingLink(o);
      o.history.push({
        event: q.body.revoke
          ? "Customer tracking revoked"
          : "Customer tracking issued",
        by: q.user.name,
        at: new Date().toISOString(),
      });
      await store.save("orders", o);
      r.json(result);
    },
  );
  app.post(
    "/api/control/orders/:id/updates",
    ...guard("work"),
    async (q, r) => {
      let o = await store.get("orders", q.params.id);
      if (!o || o.demoData) return r.sendStatus(404);
      if (q.body.queue) {
        const event =
          {
            "Out for delivery": "Out for delivery",
            Delivered: "Delivered",
            "Delivery failed": "fail",
          }[o.status] || "assign";
        if (event === "assign" && !o.driver)
          return r.status(409).json({
            error: "Assign a driver before queuing an assignment update",
          });
        if (!o.whatsappConsent || !updates.origin())
          return r.status(409).json({
            error:
              "Record WhatsApp consent and configure the public HTTPS origin first",
          });
        updates.queueUpdate(o, event, q.user.id);
        await store.save("orders", o);
        return r.json({ ok: true });
      }
      const u = o.customerUpdates?.find((u) => u.id === q.body.updateId);
      if (
        q.body.review &&
        u &&
        ["Sending", "Needs provider review"].includes(u.status)
      ) {
        const { outcome, note } = q.body.review;
        if (
          !["accepted", "not-sent"].includes(outcome) ||
          typeof note !== "string" ||
          !note.trim() ||
          note.length > 1000
        )
          return r.status(400).json({
            error: "Record the provider-log outcome and a review note",
          });
        u.status =
          outcome === "accepted"
            ? "Accepted (provider log review)"
            : "Cancelled after provider review";
        u.review = {
          outcome,
          note: note.trim(),
          by: q.user.name,
          at: new Date().toISOString(),
        };
        await store.save("orders", o);
        return r.json({ status: u.status });
      }
      if (!u || u.status !== "Queued")
        return r.status(409).json({
          error:
            "Only a queued update can be processed. Unknown or sending requests require provider-log review.",
        });
      if (q.body.cancel) {
        u.status = "Cancelled";
        await store.save("orders", o);
        return r.json({ ok: true });
      }
      if (u.orderStatus !== o.status || Date.parse(u.expires) < Date.now())
        return r.status(409).json({
          error: "Update is stale. Cancel it and queue a current update.",
        });
      if (!updates.whatsappConfigured())
        return r.status(503).json({
          error:
            "WhatsApp Business provider settings are incomplete or invalid",
        });
      u.status = "Sending";
      u.processedBy = q.user.name;
      u.processedAt = new Date().toISOString();
      o = await store.save("orders", o); // Claim before contacting provider; concurrent requests cannot send twice.
      const current = o.customerUpdates.find((x) => x.id === u.id);
      try {
        current.providerId = await updates.sendWhatsApp(o, current);
        current.status = "Accepted by provider";
      } catch (e) {
        current.status = "Needs provider review";
        current.error = e.message;
      }
      await store.save("orders", o);
      r.json({ status: current.status });
    },
  );
  app.get("/api/control/readiness", permit("admin"), async (q, r) => {
    const fs = require("node:fs"),
      path = require("node:path");
    let backup = null;
    try {
      backup = JSON.parse(
        fs.readFileSync(
          path.join(
            process.env.DATA_DIR || path.resolve("data"),
            "backup-status.json",
          ),
          "utf8",
        ),
      );
    } catch {}
    r.json({
      durableSessions: true,
      sessionSecretStable: (process.env.SESSION_SECRET || "").length >= 32,
      backend: store.backend,
      backup,
      emailConfigured: Boolean(
        updates.origin() &&
        process.env.RECOVERY_EMAIL_API_KEY &&
        process.env.RECOVERY_EMAIL_FROM,
      ),
      whatsappConfigured: updates.whatsappConfigured(),
      publicOrigin: updates.origin(),
      note: "Persistence requires a verified persistent DATA_DIR volume. Backup scheduling and off-host copies require hosting configuration. Provider configuration is not a delivery test.",
    });
  });
}
module.exports = { install, installPublic, publicUser, publicOrder };
