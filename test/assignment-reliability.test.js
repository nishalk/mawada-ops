const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { assignPickups } = require("../public/operations");
const { createStorage } = require("../storage");
test("whole-order pickup assignment validates every active leg before changing any driver", () => {
  const order = {
    status: "Created",
    pickups: [
      { id: "a", completed: false, driver: "old-a" },
      { id: "b", completed: false, driver: "old-b" },
      { id: "done", completed: true, driver: "historical" },
    ],
    trips: [{ kind: "pickup", pickupId: "b", status: "In transit" }],
  };
  assert.throws(() => assignPickups(order, "new"), /active pickup/);
  assert.deepEqual(
    order.pickups.map((p) => p.driver),
    ["old-a", "old-b", "historical"],
  );
  order.trips = [];
  assert.deepEqual(assignPickups(order, "new"), ["a", "b"]);
  assert.deepEqual(
    order.pickups.map((p) => p.driver),
    ["new", "new", "historical"],
  );
  order.pickups.forEach((p) => (p.completed = true));
  assert.throws(() => assignPickups(order, "other"), /No incomplete/);
});
test("Supabase failures preserve safe reason codes without exposing credentials or row details", async () => {
  const privateText =
    "private-token customer-details https://private-host.example";
  for (const [databaseCode, status, expected] of [
    ["42501", 403, "SUPABASE_ACCESS_DENIED"],
    ["PGRST205", 404, "SUPABASE_SCHEMA_MISMATCH"],
    ["23514", 400, "SUPABASE_RECORD_REJECTED"],
    ["57014", 504, "SUPABASE_TIMEOUT"],
    ["", 0, "SUPABASE_CONNECTION_FAILED"],
  ]) {
    const query = {
      select() {
        return this;
      },
      eq() {
        return this;
      },
      order() {
        return this;
      },
      range() {
        return Promise.resolve({
          status,
          error: {
            code: databaseCode,
            message: privateText,
            details: privateText,
            hint: privateText,
          },
        });
      },
    };
    const store = createStorage(
      {
        DATABASE_BACKEND: "supabase",
        SUPABASE_URL: "https://fixture.supabase.co",
        SUPABASE_API_KEY: "sb_secret_fixture_only",
      },
      { from: () => query },
    );
    await assert.rejects(
      store.all("orders"),
      (e) =>
        e.status === 503 &&
        e.code === expected &&
        !e.message.includes(privateText) &&
        (!databaseCode || e.databaseCode === databaseCode),
    );
  }
});
