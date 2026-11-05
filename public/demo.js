(() => {
  if (location.pathname !== "/demo") return;
  const key = "relay-sample-demo-v1";
  const photo =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1X8AAAAASUVORK5CYII=";
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function fresh() {
    const users = [
      {
        id: "demo-admin",
        name: "Demo Administrator",
        email: "admin@example.test",
        role: "admin",
      },
      { id: "demo-ops", name: "Demo Dispatcher", role: "operations" },
      { id: "demo-warehouse", name: "Demo Warehouse", role: "warehouse" },
      { id: "demo-driver", name: "Demo Driver", role: "driver" },
    ];
    const vendors = [
      {
        id: "vendor-1",
        code: "V1",
        name: "Sample Electronics",
        address: "Kuwait City · sample pickup",
        phone: "",
      },
      {
        id: "vendor-2",
        code: "V2",
        name: "Sample Home Store",
        address: "Salmiya · sample pickup",
        phone: "",
      },
    ];
    const orders = ["Created", "At warehouse", "Out for delivery"].map(
      (status, n) => ({
        id: "demo-order-" + n,
        awb: "DEMO-KW-" + (1001 + n),
        reference: "SAMPLE-" + (1001 + n),
        recipient: "Sample recipient " + (n + 1),
        address: "Hawally · fictional address",
        phone: "+96500000000",
        driver: "demo-driver",
        status,
        items: vendors.map((vendor, i) => ({
          id: "demo-item-" + n + "-" + i,
          vendor,
          name: i ? "Home accessory" : "Electronics box",
          quantity: 1,
          received: n > 0,
        })),
        pickups: vendors.map((vendor, i) => ({
          id: "demo-pickup-" + n + "-" + i,
          vendor,
          driver: "demo-driver",
          completed: n > 0,
        })),
        history: [
          { event: "Sample order created", at: new Date().toISOString() },
        ],
      }),
    );
    Object.assign(orders[1], {
      source: "Mawada CMS",
      deliveryDate: new Date(Date.now() + 3 * 3600000)
        .toISOString()
        .slice(0, 10),
      timeSlot: "14:00–17:00",
      amountFils: 17500,
      ringBell: false,
      cardAvailable: true,
      extraDirections: "Sample: use the side entrance; do not ring the bell.",
      occasion: {
        value: "Birthday",
        source: "Sample unconfirmed suggestion",
        needsReview: true,
        candidates: ["Birthday"],
      },
    });
    const extra = clone(orders[1]);
    extra.id = "demo-order-3";
    extra.awb = "DEMO-KW-1004";
    extra.reference = "SAMPLE-1004";
    extra.driver = null;
    extra.pickups.forEach((p, i) => {
      p.driver = null;
      p.id = "demo-pickup-3-" + i;
    });
    extra.items.forEach((item, i) => (item.id = "demo-item-3-" + i));
    orders.push(extra);
    users.push({
      id: "demo-driver2",
      name: "Sample Driver Two",
      role: "driver",
    });
    for (const [i, u] of users.filter((u) => u.role === "driver").entries()) {
      u.locationSharing = true;
      u.lastLocation = {
        lat: 29.3759 - i * 0.0384,
        lng: 47.9774 + i * 0.0477,
        accuracy: 15,
        at: new Date().toISOString(),
        source: "demo",
      };
    }
    const demoDriver = users.find((u) => u.id === "demo-driver");
    demoDriver.locationAlerts = [
      {
        id: "sample-location-jump",
        kind: "Location jump",
        at: new Date().toISOString(),
        detail:
          "SIMULATED EXAMPLE: GPS moved 4 km in 30 seconds. Review GPS accuracy and confirm with the driver. This is fictional demo data.",
      },
    ];
    return { users, vendors, orders, userId: "demo-admin" };
  }
  let data;
  try {
    data = JSON.parse(sessionStorage.getItem(key)) || fresh();
  } catch {
    data = fresh();
  }
  if (!data.users.some((u) => u.id === "demo-driver2"))
    data.users.push({
      id: "demo-driver2",
      name: "Sample Driver Two",
      role: "driver",
    });
  for (const order of data.orders) {
    order.items.forEach((i) => {
      i.photo ||= "/brand/demo-gift.png";
      i.simulatedPhoto = true;
    });
    order.proofs ||= [];
    for (const p of order.pickups)
      if (p.completed && !p.proof) {
        p.proof = {
          name: "DEMO · Vendor contact",
          at: order.history[0]?.at || new Date().toISOString(),
          lat: 29.3759,
          lng: 47.9774,
          photo: "/brand/demo-gift.png",
          simulated: true,
        };
        order.proofs.push({
          ...p.proof,
          stage: "Vendor pickup",
          vendor: p.vendor.name,
          pickup: p.id,
        });
      }
    for (const p of order.proofs) {
      p.simulated = true;
      if (!p.photo || p.photo === photo) p.photo = "/brand/demo-gift.png";
      if (p.stage === "Delivered") p.signature ||= "/brand/demo-signature.png";
    }
  }
  for (const order of data.orders) RelayOperations.normaliseTrips(order);
  const persist = () => sessionStorage.setItem(key, JSON.stringify(data));
  const current = () => data.users.find((u) => u.id === data.userId);
  function fail(message) {
    throw Error(message);
  }
  function sync(o) {
    o.status = o.items.every((i) => i.received)
      ? "At warehouse"
      : o.pickups.every((p) => p.completed)
        ? "Picked up"
        : "Created";
  }
  function assertManager() {
    if (!["admin", "operations"].includes(current().role))
      fail("Dispatcher access required");
  }
  function warehouse() {
    if (!["admin", "warehouse"].includes(current().role))
      fail("Warehouse access required");
  }
  function driver(id) {
    if (!data.users.some((u) => u.id === id && u.role === "driver"))
      fail("Choose a driver");
    return id;
  }
  async function request(url, b) {
    if (url === "setup") return { required: false };
    if (url === "state")
      return clone({
        user: current(),
        users: ["admin", "operations"].includes(current().role)
          ? data.users
          : [],
        vendors: current().role === "driver" ? [] : data.vendors,
        orders: data.orders.filter(
          (o) =>
            current().role !== "driver" ||
            o.driver === current().id ||
            o.pickups.some((p) => p.driver === current().id),
        ),
        storageBackend: "demo",
        fleet: ["admin", "operations"].includes(current().role)
          ? RelayOperations.fleet(data.users, data.orders)
          : undefined,
      });
    if (url.startsWith("reports")) {
      assertManager();
      const filters = Object.fromEntries(
        new URL("https://demo.local/" + url).searchParams,
      );
      return {
        orders: RelayOperations.report(data.orders, data.users, filters),
        generatedAt: new Date().toISOString(),
      };
    }
    if (url.startsWith("driver/")) {
      if (current().role !== "driver") fail("Driver access required");
      if (url.startsWith("driver/lookup")) {
        const awb = new URL("https://demo.local/" + url).searchParams
          .get("awb")
          ?.trim()
          .toUpperCase();
        const o = data.orders.find((o) => o.awb === awb);
        if (!o) fail("No available order matches that AWB.");
        const pickups = o.pickups.filter(
          (p) =>
            !p.completed &&
            (!p.driver || p.driver === current().id) &&
            ["Created", "Picked up"].includes(o.status),
        );
        const deliveryAvailable =
          o.status === "At warehouse" &&
          o.items.every((i) => i.received) &&
          (!o.driver || o.driver === current().id);
        if (!pickups.length && !deliveryAvailable)
          fail("This order is not available to claim.");
        return clone({
          id: o.id,
          awb: o.awb,
          reference: o.reference,
          status: o.status,
          recipient: o.recipient,
          address: o.address,
          items: o.items.map((i) => ({
            id: i.id,
            name: i.name,
            quantity: i.quantity,
            vendor: i.vendor.name,
          })),
          pickups: pickups.map((p) => ({
            id: p.id,
            name: p.vendor.name,
            address: p.vendor.address,
          })),
          deliveryAvailable,
        });
      }
      if (url === "driver/claim") {
        const o = data.orders.find(
          (o) => o.awb === b.awb?.trim().toUpperCase(),
        );
        if (!o) fail("No available order matches that AWB.");
        RelayOperations.claimOrder(o, current().id, b.leg, b.pickupId);
        o.history.push({
          event: "Driver claimed " + b.leg,
          by: current().name,
          actorId: current().id,
          pickup: b.pickupId,
          at: new Date().toISOString(),
        });
        persist();
        return clone(o);
      }
      if (url === "driver/shift") {
        if (b.action === "start") {
          if (current().shift?.active) fail("Shift already started");
          current().shift = {
            active: true,
            startedAt: new Date().toISOString(),
          };
        } else if (b.action === "end") {
          if (!current().shift?.active) fail("No active shift");
          if (
            data.orders.some((o) =>
              RelayOperations.activeTrips(o).some(
                (t) => t.driver === current().id,
              ),
            )
          )
            fail("Complete active trips before ending the shift");
          current().shift = {
            ...current().shift,
            active: false,
            endedAt: new Date().toISOString(),
          };
        } else fail("Choose start or end");
        current().activity = [
          ...(current().activity || []),
          {
            event: b.action === "start" ? "Shift started" : "Shift ended",
            at: new Date().toISOString(),
            actorId: current().id,
          },
        ];
      } else if (url === "driver/location") {
        if (
          !Number.isFinite(b.lat) ||
          !Number.isFinite(b.lng) ||
          !Number.isFinite(b.accuracy) ||
          Math.abs(b.lat) > 90 ||
          Math.abs(b.lng) > 180
        )
          fail("Valid GPS coordinates required");
        RelayOperations.recordLocation(current(), {
          ...b,
          at: new Date().toISOString(),
          source: "demo",
        });
      } else if (url === "driver/sharing")
        current().locationSharing = Boolean(b.enabled);
      else fail("Unknown driver action");
      persist();
      return { ok: true };
    }
    if (url.startsWith("fleet/") && url.endsWith("/review")) {
      if (!["admin", "operations"].includes(current().role))
        fail("Access denied");
      const user = data.users.find((u) => u.id === url.split("/")[1]);
      const flag =
        user &&
        RelayOperations.driverAlerts(user, data.orders).find(
          (f) => f.id === b.alertId,
        );
      if (!flag || !String(b.note || "").trim()) fail("Enter a review note");
      user.alertReviews ||= {};
      user.alertReviews[flag.id] = {
        note: String(b.note).slice(0, 500),
        kind: flag.kind,
        detail: flag.detail,
        flaggedAt: flag.at,
        by: current().name,
        at: new Date().toISOString(),
      };
      persist();
      return { ok: true };
    }
    if (url === "logout") {
      data.userId = "demo-admin";
      persist();
      return { ok: true };
    }
    if (url === "vendors") {
      assertManager();
      if (
        !b.code ||
        !b.name ||
        !b.address ||
        data.vendors.some((v) => v.code === b.code)
      )
        fail("Unique vendor code, name and address required");
      data.vendors.push({ ...b, id: crypto.randomUUID() });
    } else if (url === "users") {
      fail("Create real login accounts in the live app, not the sample demo.");
    } else if (url === "orders") {
      assertManager();
      if (
        !b.reference ||
        data.orders.some((o) => o.reference === b.reference) ||
        !b.items?.length ||
        !/^\+965\d{8}$/.test(b.phone)
      )
        fail("Unique reference, items and a +965 phone required");
      const items = b.items.map((i) => {
        const vendor = data.vendors.find((v) => v.code === i.vendorCode);
        if (
          !vendor ||
          !i.name ||
          !Number.isInteger(i.quantity) ||
          i.quantity < 1
        )
          fail("Check each item and vendor");
        return { ...i, id: crypto.randomUUID(), vendor, received: false };
      });
      data.orders.unshift({
        ...b,
        id: crypto.randomUUID(),
        awb: "DEMO-KW-" + crypto.randomUUID().slice(0, 8).toUpperCase(),
        items,
        status: "Created",
        driver: null,
        pickups: [
          ...new Map(items.map((i) => [i.vendor.id, i.vendor])).values(),
        ].map((vendor) => ({
          id: crypto.randomUUID(),
          vendor,
          completed: false,
          driver: null,
        })),
        history: [{ event: "Created", at: new Date().toISOString() }],
      });
    } else if (url.startsWith("import"))
      fail(
        "Excel uploads are available in the connected live app. In this sample demo, use New order to try order entry.",
      );
    else if (url.startsWith("orders/")) {
      const o = data.orders.find((o) => o.id === url.split("/")[1]);
      if (!o) fail("Order not found");
      const manager = ["admin", "operations"].includes(current().role),
        assigned = current().role === "driver" && o.driver === current().id;
      const t = o.pickups.find((p) => p.id === b.pickup);
      RelayOperations.normaliseTrips(o);
      const at = new Date().toISOString();
      if (b.action === "review-occasion") {
        assertManager();
        if (!b.occasion?.trim()) fail("Enter an occasion label");
        o.occasion = {
          value: b.occasion.trim(),
          source: "Operations review",
          needsReview: false,
          reviewedBy: current().name,
          reviewedAt: at,
        };
      } else if (
        ["start-pickup-trip", "arrived-pickup", "pickup-failed"].includes(
          b.action,
        )
      ) {
        if (!t || (!manager && t.driver !== current().id))
          fail("Assigned pickup driver access required");
        if (b.action === "start-pickup-trip")
          RelayOperations.startPickup(
            o,
            t.id,
            t.driver,
            crypto.randomUUID(),
            at,
          );
        else {
          const trip = RelayOperations.activeTrips(o).find(
            (t2) => t2.kind === "pickup" && t2.pickupId === t.id,
          );
          if (!trip) fail("Start the pickup trip first");
          if (b.action === "arrived-pickup") {
            trip.milestone = "Arrived at pickup";
            trip.arrivedAt = at;
          } else {
            if (!b.reason?.trim()) fail("A pickup failure reason is required");
            RelayOperations.finishTrip(
              o,
              "pickup",
              t.id,
              "Failed",
              at,
              b.reason,
            );
            t.lastFailure = b.reason;
          }
        }
      } else if (b.action === "arrived-delivery") {
        if (!manager && !assigned)
          fail("Assigned delivery driver access required");
        if (o.status !== "Out for delivery")
          fail("Start the delivery trip first");
        const trip = RelayOperations.activeTrips(o).find(
          (t) => t.kind === "delivery",
        );
        trip.milestone = "Arrived at delivery";
        trip.arrivedAt = at;
      } else if (b.action === "assign") {
        assertManager();
        if (["Delivered", "Out for delivery"].includes(o.status))
          fail("Cannot reassign during or after delivery");
        o.driver = driver(b.driver);
      } else if (b.action === "assign-pickups") {
        assertManager();
        RelayOperations.assignPickups(o, driver(b.driver));
      } else if (b.action === "assign-pickup") {
        assertManager();
        if (!t || t.completed) fail("Select an incomplete pickup");
        if (
          RelayOperations.activeTrips(o).some(
            (trip) => trip.kind === "pickup" && trip.pickupId === t.id,
          )
        )
          fail("Finish or fail the active pickup trip before reassigning");
        t.driver = driver(b.driver);
      } else if (b.action === "pickup") {
        if (!t || t.completed || !t.driver)
          fail("Assign an incomplete pickup first");
        if (!manager && t.driver !== current().id)
          fail("This pickup is assigned to another driver");
        if (
          !b.name ||
          !b.photo ||
          o.items
            .filter((i) => i.vendor.id === t.vendor.id)
            .some((i) => !b.verifiedItems.includes(i.id))
        )
          fail("Verify all pickup items and add handover details");
        if (
          current().role === "driver" &&
          !RelayOperations.activeTrips(o).some((trip) => trip.pickupId === t.id)
        )
          fail("Start the pickup trip first");
        t.completed = true;
        t.proof = { ...b, at };
        RelayOperations.finishTrip(o, "pickup", t.id, "Completed", at);
        (o.proofs ??= []).push({
          ...b,
          stage: "Vendor pickup",
          vendor: t.vendor.name,
          at: new Date().toISOString(),
        });
        sync(o);
      } else if (b.action === "receive") {
        warehouse();
        const i = o.items.find((i) => i.id === b.item);
        if (
          !i ||
          !o.pickups.find((p) => p.vendor.id === i.vendor.id)?.completed
        )
          fail("Complete vendor pickup first");
        i.received = true;
        sync(o);
      } else if (b.action === "add-item") {
        warehouse();
        if (!["Created", "Picked up", "At warehouse"].includes(o.status))
          fail("Add items before dispatch");
        const vendor = data.vendors.find((v) => v.code === b.vendorCode),
          quantity = Number(b.quantity);
        if (!vendor || !b.name || !Number.isInteger(quantity) || quantity < 1)
          fail("Valid item, quantity and vendor required");
        o.items.push({
          id: crypto.randomUUID(),
          name: b.name,
          quantity,
          vendor,
          received: true,
          source: "Warehouse addition",
        });
        if (!o.pickups.some((p) => p.vendor.id === vendor.id))
          o.pickups.push({ id: crypto.randomUUID(), vendor, completed: true });
        sync(o);
      } else if (b.action === "Out for delivery") {
        if (!manager && !assigned) fail("Assigned driver access required");
        if (
          o.status !== "At warehouse" ||
          !o.driver ||
          o.items.some((i) => !i.received || !b.verifiedItems?.includes(i.id))
        )
          fail("All items must be received, assigned and verified");
        if (
          o.deliveryDate &&
          o.deliveryDate >
            new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)
        )
          fail("Scheduled delivery date has not arrived");
        o.status = "Out for delivery";
        RelayOperations.startDelivery(o, crypto.randomUUID(), at);
      } else if (b.action === "Delivered") {
        if (!manager && !assigned) fail("Assigned driver access required");
        if (
          o.status !== "Out for delivery" ||
          !b.name ||
          !b.signature ||
          !b.photo
        )
          fail("Delivery requires recipient name, signature and photo");
        o.status = "Delivered";
        RelayOperations.finishTrip(o, "delivery", null, "Completed", at);
        (o.proofs ??= []).push({
          ...b,
          stage: "Delivered",
          at: new Date().toISOString(),
        });
      } else if (b.action === "fail") {
        if (!manager && !assigned) fail("Assigned driver access required");
        if (o.status !== "Out for delivery" || !b.reason?.trim())
          fail("Enter a reason for this dispatched order");
        RelayOperations.finishTrip(o, "delivery", null, "Failed", at, b.reason);
        o.status = "Delivery failed";
        o.returned = false;
        (o.attempts ??= []).push({
          reason: b.reason,
          at: new Date().toISOString(),
        });
      } else if (b.action === "return") {
        warehouse();
        if (o.status !== "Delivery failed") fail("Choose a failed delivery");
        o.returned = true;
      } else if (b.action === "reschedule") {
        assertManager();
        if (o.status !== "Delivery failed" || !o.returned || !b.date)
          fail("Confirm warehouse return and choose a date");
        o.deliveryDate = b.date;
        o.driver = null;
        o.status = "At warehouse";
      } else fail("Unsupported sample action");
      o.history.push({
        event: b.action,
        by: current().name,
        at: new Date().toISOString(),
        reason: b.reason,
        date: b.date,
      });
    } else fail("This action is unavailable in the sample demo");
    persist();
    return { ok: true };
  }
  window.relayDemo = { request, samplePhoto: photo };
  const banner = document.createElement("aside");
  banner.className = "demoBanner";
  banner.innerHTML =
    '<strong>SAMPLE DEMO</strong><span>Fictional orders · saved only in this browser tab · simulated GPS · no customer notifications. Do not enter real customer data. Pickup photos are optional here.</span><label>Try a role <select id="demoRole"></select></label><button id="resetDemo">Reset sample orders</button><a href="/">Live app</a>';
  document.querySelector("header").after(banner);
  const select = banner.querySelector("select");
  for (const u of data.users) {
    const option = document.createElement("option");
    option.value = u.id;
    option.textContent = u.name + " · " + u.role;
    option.selected = data.userId === u.id;
    select.append(option);
  }
  select.onchange = async () => {
    try {
      await stopLocationSharing();
    } catch {}
    data.userId = select.value;
    persist();
    location.reload();
  };
  banner.querySelector("button").onclick = () => {
    if (confirm("Reset all sample changes in this browser tab?")) {
      sessionStorage.removeItem(key);
      location.reload();
    }
  };
})();
