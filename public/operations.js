/* Shared operational rules for the real app and the isolated sample demo. */
((root, factory) => {
  const operations = factory();
  if (typeof module === "object" && module.exports) module.exports = operations;
  else root.RelayOperations = operations;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const reject = (message) => {
    throw Object.assign(new Error(message), { status: 409 });
  };
  const activeTrips = (order) =>
    (order.trips || []).filter((t) => t.status === "In transit");
  function assignPickups(order, driverId) {
    const pending = (order.pickups || []).filter((p) => !p.completed);
    if (!pending.length)
      reject("No incomplete vendor pickups remain on this order.");
    if (!["Created", "Picked up", "At warehouse"].includes(order.status))
      reject("Pickups cannot be assigned at this order stage.");
    if (
      activeTrips(order).some(
        (t) => t.kind === "pickup" && pending.some((p) => p.id === t.pickupId),
      )
    )
      reject(
        "Finish or fail every active pickup trip before reassigning this order.",
      );
    for (const p of pending) p.driver = driverId;
    return pending.map((p) => p.id);
  }
  function normaliseTrips(order) {
    order.trips ||= [];
    if (
      order.status === "Out for delivery" &&
      order.driver &&
      !order.trips.some(
        (t) => t.kind === "delivery" && t.status === "In transit",
      )
    ) {
      order.trips.push({
        id: order.id + "-legacy-delivery",
        kind: "delivery",
        driver: order.driver,
        status: "In transit",
        milestone: "On the road",
        startedAt:
          order.history?.findLast((h) => h.event === "Out for delivery")?.at ||
          null,
        legacy: true,
      });
    }
    return order;
  }
  function claimOrder(order, driverId, leg, pickupId) {
    if (leg === "delivery") {
      if (
        order.status !== "At warehouse" ||
        !order.items.length ||
        order.items.some((i) => !i.received)
      )
        reject(
          "Delivery can only be claimed after every item reaches the warehouse.",
        );
      if (order.driver && order.driver !== driverId)
        reject("This delivery is already assigned to another driver.");
      order.driver = driverId;
    } else if (leg === "pickup") {
      const task = order.pickups.find((p) => p.id === pickupId);
      if (
        !task ||
        task.completed ||
        !["Created", "Picked up"].includes(order.status)
      )
        reject("Choose an incomplete pickup.");
      if (task.driver && task.driver !== driverId)
        reject("This pickup is already assigned to another driver.");
      task.driver = driverId;
    } else reject("Choose pickup or delivery.");
    return order;
  }
  function startPickup(order, pickupId, driverId, tripId, at) {
    const task = order.pickups.find((p) => p.id === pickupId);
    if (
      !task ||
      task.completed ||
      task.driver !== driverId ||
      !["Created", "Picked up"].includes(order.status)
    )
      reject("An assigned, incomplete pickup is required.");
    order.trips ||= [];
    if (
      activeTrips(order).some(
        (t) => t.kind === "pickup" && t.pickupId === pickupId,
      )
    )
      reject("This pickup trip has already started.");
    const trip = {
      id: tripId,
      kind: "pickup",
      pickupId,
      driver: driverId,
      status: "In transit",
      milestone: "Travelling to pickup",
      startedAt: at,
    };
    order.trips.push(trip);
    return trip;
  }
  function startDelivery(order, tripId, at) {
    order.trips ||= [];
    if (activeTrips(order).some((t) => t.kind === "delivery"))
      reject("This delivery trip has already started.");
    const trip = {
      id: tripId,
      kind: "delivery",
      driver: order.driver,
      status: "In transit",
      milestone: "On the road",
      startedAt: at,
    };
    order.trips.push(trip);
    return trip;
  }
  function finishTrip(order, kind, pickupId, status, at, reason) {
    const trip = activeTrips(order).find(
      (t) => t.kind === kind && (kind !== "pickup" || t.pickupId === pickupId),
    );
    if (trip)
      Object.assign(trip, {
        status,
        endedAt: at,
        ...(reason ? { reason } : {}),
      });
    return trip;
  }
  const monitoring = {
    idleMinutes: 20,
    staleMinutes: 5,
    radiusMetres: 150,
    maxAccuracy: 100,
    jumpKph: 160,
  };
  function distance(a, b) {
    const rad = (n) => (n * Math.PI) / 180;
    const x =
      Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
      Math.cos(rad(a.lat)) *
        Math.cos(rad(b.lat)) *
        Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, x)));
  }
  function recordLocation(user, position) {
    const prev = user.lastLocation;
    const at = Date.parse(position.at);
    user.locationHistory = (user.locationHistory || [])
      .filter((p) => at - Date.parse(p.at) <= 86400000)
      .slice(-1999);
    const reliable = (p) => p && p.accuracy <= monitoring.maxAccuracy;
    const gap = prev ? at - Date.parse(prev.at) : Infinity;
    const continuous = gap >= 10000 && gap <= 120000 && user.locationSharing;
    user.locationAlerts = (user.locationAlerts || []).slice(-99);
    if (continuous && reliable(prev) && reliable(position)) {
      const metres = Math.max(
        0,
        distance(prev, position) - prev.accuracy - position.accuracy,
      );
      const kph = (metres / gap) * 3600;
      if (kph > monitoring.jumpKph)
        user.locationAlerts.push({
          id: "jump-" + position.at,
          kind: "Location jump",
          at: position.at,
          detail: `GPS changed ${Math.round(distance(prev, position))} m in ${Math.round(gap / 1000)} seconds (at least ${Math.round(kph)} km/h after accuracy allowance). Check GPS error or device changes.`,
          from: prev,
          to: position,
        });
    }
    if (
      !continuous ||
      !reliable(prev) ||
      !reliable(position) ||
      !user.stationary ||
      distance(user.stationary, position) > monitoring.radiusMetres
    ) {
      user.stationary = reliable(position)
        ? { ...position, since: position.at }
        : null;
    }
    user.lastLocation = position;
    user.locationHistory.push(position);
    user.locationSharing = true;
  }
  function driverAlerts(user, orders, at = Date.now()) {
    const trips = orders.flatMap((o) =>
      activeTrips(o).filter((t) => t.driver === user.id),
    );
    const latestStart = Math.max(
      ...trips.map((t) => Date.parse(t.startedAt)).filter(Number.isFinite),
    );
    const flags = [...(user.locationAlerts || [])];
    const pos = user.lastLocation;
    const age = pos ? at - Date.parse(pos.at) : Infinity;
    if (
      trips.length &&
      (!user.locationSharing || age > monitoring.staleMinutes * 60000)
    )
      flags.push({
        id:
          "gap-" +
          (Number.isFinite(latestStart) ? latestStart : "active") +
          "-" +
          (pos?.at || "missing"),
        kind: "Tracking gap",
        at: pos?.at || null,
        detail:
          "Active trip with GPS paused, missing or older than 5 minutes. The browser may be closed, the phone locked or connectivity lost.",
      });
    const since = Math.max(Date.parse(user.stationary?.since), latestStart);
    if (
      trips.length &&
      user.locationSharing &&
      age <= 120000 &&
      at - since >= monitoring.idleMinutes * 60000
    )
      flags.push({
        id: "idle-" + user.stationary.since,
        kind: "Long stop",
        at: user.stationary.since,
        detail: `Within 150 m for ${Math.floor((at - since) / 60000)} minutes during an active trip, with continuous accurate GPS. Confirm waiting, traffic or an authorised break.`,
      });
    for (const o of orders)
      for (const proof of o.proofs || []) {
        if (
          proof.driverId !== user.id ||
          !Number.isFinite(proof.lat) ||
          !Number.isFinite(proof.lng)
        )
          continue;
        const nearby = [proof.gpsAtCapture, ...(user.locationHistory || [])]
          .filter(Boolean)
          .filter(
            (p) =>
              p.accuracy <= monitoring.maxAccuracy &&
              Math.abs(Date.parse(p.at) - Date.parse(proof.at)) <= 120000,
          )
          .sort(
            (a, b) =>
              Math.abs(Date.parse(a.at) - Date.parse(proof.at)) -
              Math.abs(Date.parse(b.at) - Date.parse(proof.at)),
          )[0];
        if (nearby && distance(nearby, proof) - nearby.accuracy > 500)
          flags.push({
            id: "proof-" + o.id + "-" + proof.at,
            kind: "Proof / GPS discrepancy",
            at: proof.at,
            awb: o.awb,
            detail: `${o.awb}: ${proof.stage} proof is ${Math.round(distance(nearby, proof))} m from GPS recorded within 2 minutes. Compare the proof and contact the driver; this does not check the destination address.`,
          });
      }
    return flags.map((f) => ({
      ...f,
      review: (user.alertReviews || {})[f.id] || null,
    }));
  }
  function fleet(users, orders, at = Date.now()) {
    return users
      .filter((u) => u.role === "driver")
      .map((user) => {
        const deliveries = orders.filter((o) => o.driver === user.id);
        const tasks = orders.flatMap((o) =>
          o.pickups
            .filter((p) => p.driver === user.id)
            .map((p) => ({
              id: p.id,
              driver: p.driver,
              completed: p.completed,
              vendor: {
                id: p.vendor.id,
                name: p.vendor.name,
                address: p.vendor.address,
              },
              awb: o.awb,
              orderId: o.id,
            })),
        );
        const trips = orders.flatMap((o) =>
          activeTrips(o)
            .filter((t) => t.driver === user.id)
            .map((t) => ({ ...t, awb: o.awb, reference: o.reference })),
        );
        const assignedOrders = orders.filter(
          (o) =>
            (o.driver === user.id && o.status !== "Delivered") ||
            o.pickups.some((p) => p.driver === user.id && !p.completed),
        );
        return {
          id: user.id,
          name: user.name,
          shipmentsHandled: orders.filter(
            (o) =>
              o.driver === user.id ||
              o.pickups.some((p) => p.driver === user.id) ||
              (o.trips || []).some((t) => t.driver === user.id) ||
              o.history.some((h) => h.driverId === user.id),
          ).length,
          shipments: orders
            .filter(
              (o) =>
                o.driver === user.id ||
                o.pickups.some((p) => p.driver === user.id) ||
                (o.trips || []).some((t) => t.driver === user.id) ||
                o.history.some((h) => h.driverId === user.id),
            )
            .map((o) => ({
              id: o.id,
              awb: o.awb,
              reference: o.reference,
              recipient: o.recipient,
              address: o.address,
              status: o.status,
              deliveryAssigned: o.driver === user.id,
              pickups: o.pickups
                .filter((p) => p.driver === user.id)
                .map((p) => ({
                  vendor: p.vendor.name,
                  address: p.vendor.address,
                  completed: p.completed,
                })),
              trips: (o.trips || []).filter((t) => t.driver === user.id),
            })),
          alerts: driverAlerts(user, orders, at),
          reviews: Object.entries(user.alertReviews || {}).map(
            ([id, review]) => ({ id, ...review }),
          ),
          lastLocation: user.lastLocation || null,
          locationSharing: Boolean(user.locationSharing),
          assignedOrders: assignedOrders.length,
          pendingDeliveries: deliveries.filter((o) =>
            ["Created", "Picked up", "At warehouse"].includes(o.status),
          ).length,
          inTransitDeliveries: deliveries.filter(
            (o) => o.status === "Out for delivery",
          ).length,
          failedDeliveries: deliveries.filter(
            (o) => o.status === "Delivery failed",
          ).length,
          delivered: orders.filter(
            (o) =>
              (o.proofs || []).some(
                (p) => p.stage === "Delivered" && p.driverId === user.id,
              ) ||
              (o.driver === user.id && o.status === "Delivered"),
          ).length,
          pendingPickups: tasks.filter((p) => !p.completed).length,
          completedPickups: tasks.filter((p) => p.completed).length,
          activeTrips: trips,
          pickups: tasks,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  function report(orders, users, filters = {}) {
    const names = new Map(users.map((u) => [u.id, u.name]));
    const date = (value) => {
      if (!value) return null;
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
      )
        throw Error("Use a valid date.");
      return value;
    };
    const from = date(filters.from),
      to = date(filters.to);
    if (from && to && from > to)
      throw Error("The start date must be on or before the end date.");
    const inRange = (at) => {
      if (!at) return false;
      const day = new Date(new Date(at).getTime() + 3 * 3600000)
        .toISOString()
        .slice(0, 10);
      return (!from || day >= from) && (!to || day <= to);
    };
    return orders
      .filter(
        (o) =>
          (!filters.status || o.status === filters.status) &&
          (!filters.driver ||
            o.driver === filters.driver ||
            o.pickups.some((p) => p.driver === filters.driver) ||
            (o.trips || []).some((t) => t.driver === filters.driver) ||
            o.history.some(
              (h) =>
                h.driverId === filters.driver || h.actorId === filters.driver,
            )) &&
          (!(from || to) || o.history.some((h) => inRange(h.at))),
      )
      .map((o) => ({
        id: o.id,
        awb: o.awb,
        reference: o.reference,
        status: o.status,
        recipient: o.recipient,
        phone: o.phone,
        address: o.address,
        driver: names.get(o.driver) || "Unassigned",
        driverId: o.driver,
        createdAt: o.history[0]?.at || null,
        deliveryDate: o.deliveryDate || null,
        timeSlot: o.timeSlot || "",
        amountFils: o.amountFils ?? null,
        ringBell: o.ringBell ?? null,
        cardAvailable: o.cardAvailable ?? null,
        extraDirections: o.extraDirections || "",
        occasion: o.occasion || null,
        items: o.items.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          vendor: i.vendor.name,
          received: i.received,
        })),
        pickups: o.pickups.map((p) => ({
          id: p.id,
          vendor: p.vendor.name,
          address: p.vendor.address,
          driver: names.get(p.driver) || "Unassigned",
          completed: p.completed,
          proof: p.proof
            ? {
                name: p.proof.name,
                at: p.proof.at,
                lat: p.proof.lat,
                lng: p.proof.lng,
              }
            : null,
        })),
        delivery: (o.proofs || [])
          .filter((p) => p.stage === "Delivered")
          .map((p) => ({
            name: p.name,
            at: p.at,
            lat: p.lat,
            lng: p.lng,
            signatureCaptured: Boolean(p.signature),
            photoCaptured: Boolean(p.photo),
          })),
        attempts: o.attempts || [],
        history: o.history.map((h) => ({ ...h })),
        trips: (o.trips || []).map((t) => ({
          ...t,
          driver: names.get(t.driver) || t.driver,
        })),
      }));
  }
  function dailyOverview(orders, at = Date.now()) {
    const day = (value) =>
      Number.isFinite(Date.parse(value))
        ? new Date(Date.parse(value) + 10800000).toISOString().slice(0, 10)
        : null;
    const today = day(new Date(at).toISOString()),
      yesterday = day(new Date(at - 86400000).toISOString());
    const deadline = (o) => {
      if (
        o.deliveryDueAt &&
        /(?:Z|[+-]\d\d:\d\d)$/.test(o.deliveryDueAt) &&
        Number.isFinite(Date.parse(o.deliveryDueAt))
      )
        return Date.parse(o.deliveryDueAt);
      const slot = String(o.timeSlot || "").match(
        /^\s*(?:[01]?\d|2[0-3]):[0-5]\d\s*[-–]\s*((?:[01]?\d|2[0-3]):[0-5]\d)\s*$/,
      );
      if (!slot || !/^\d{4}-\d{2}-\d{2}$/.test(o.deliveryDate || ""))
        return null;
      return Date.parse(
        o.deliveryDate + "T" + slot[1].padStart(5, "0") + ":00+03:00",
      );
    };
    const deliveryProof = (o) =>
      (o.proofs || []).filter((p) => p.stage === "Delivered").at(-1);
    const result = (date) => {
      const due = orders.filter((o) => o.deliveryDate === date);
      const completed = orders.filter(
        (o) => day(deliveryProof(o)?.at) === date,
      );
      const pickups = orders.flatMap((o) =>
        o.pickups.map((p) => ({ ...p, awb: o.awb, orderId: o.id })),
      );
      const duePickups = pickups.filter((p) => day(p.dueAt) === date);
      const delayRows = due
        .filter((o) => {
          const end = deadline(o);
          return (
            end !== null &&
            (deliveryProof(o)
              ? Date.parse(deliveryProof(o).at) > end
              : at > end)
          );
        })
        .map((o) => ({
          awb: o.awb,
          orderId: o.id,
          status: o.status,
          minutes: Math.floor(
            ((deliveryProof(o) ? Date.parse(deliveryProof(o).at) : at) -
              deadline(o)) /
              60000,
          ),
          pending: !deliveryProof(o),
        }));
      const pickupDelays = duePickups.filter((p) =>
        p.completed
          ? Date.parse(p.proof?.at) > Date.parse(p.dueAt)
          : at > Date.parse(p.dueAt),
      );
      const orderRow = (o) => ({
        orderId: o.id,
        awb: o.awb,
        recipient: o.recipient,
        status: o.status,
      });
      const pickupRow = (p) => ({
        orderId: p.orderId,
        pickupId: p.id,
        awb: p.awb,
        vendor: p.vendor.name,
        status: p.completed ? "Collected" : "Pending",
      });
      return {
        details: {
          due: due.map(orderRow),
          delivered: completed.map(orderRow),
          remaining: due.filter((o) => !deliveryProof(o)).map(orderRow),
          pickupsCompleted: pickups
            .filter((p) => p.completed && day(p.proof?.at) === date)
            .map(pickupRow),
          lateDeliveries: delayRows,
          latePickups: pickupDelays.map(pickupRow),
        },
        date,
        due: due.length,
        delivered: completed.length,
        pickupsCompleted: pickups.filter(
          (p) => p.completed && day(p.proof?.at) === date,
        ).length,
        failed: orders.reduce(
          (n, o) =>
            n + (o.attempts || []).filter((a) => day(a.at) === date).length,
          0,
        ),
        lateDeliveries: delayRows.length,
        deliveryUnknown: due.filter((o) => deadline(o) === null).length,
        pickupsDue: duePickups.length,
        latePickups: pickupDelays.length,
        pickupUnknown: pickups.filter((p) => !p.dueAt).length,
        delayRows,
        pickupDelayRows: pickupDelays.map((p) => ({
          awb: p.awb,
          vendor: p.vendor.name,
          completed: p.completed,
        })),
        remaining: due.filter((o) => !deliveryProof(o)).length,
      };
    };
    return { today: result(today), yesterday: result(yesterday) };
  }
  return {
    dailyOverview,
    monitoring,
    distance,
    recordLocation,
    driverAlerts,
    activeTrips,
    assignPickups,
    normaliseTrips,
    claimOrder,
    startPickup,
    startDelivery,
    finishTrip,
    fleet,
    report,
  };
});
