const { chromium } = require("playwright"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mawada-chat-browser-"));
  Object.assign(process.env, {
    DATA_DIR: dir,
    DATABASE_BACKEND: "sqlite",
    NODE_ENV: "test",
    SESSION_SECRET: "chat-browser-only-stable-secret-1234567890123",
  });
  let server, browser;
  try {
    const app = await require("../application").createApplication();
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const url = "http://127.0.0.1:" + server.address().port;
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      headless: true,
      args: ["--no-sandbox"],
    });
    const admin = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      driver = await browser.newContext({
        viewport: { width: 412, height: 915 },
      });
    for (const c of [admin, driver])
      await c.route("https://tile.openstreetmap.org/**", (r) => r.abort());
    const call = async (c, route, body) => {
      const r = body
        ? await c.request.post(url + "/api/" + route, { data: body })
        : await c.request.get(url + "/api/" + route);
      assert.equal(r.status(), 200, await r.text());
      return r.json();
    };
    const password = "browser-chat-password-123";
    await call(admin, "setup", {
      name: "Dispatcher",
      email: "admin@example.test",
      password,
    });
    await call(admin, "login", { email: "admin@example.test", password });
    await call(admin, "users", {
      name: "Delivery Driver",
      email: "driver@example.test",
      password,
      role: "driver",
    });
    await call(driver, "login", { email: "driver@example.test", password });
    const driverId = (await call(driver, "state")).user.id;
    await call(admin, "vendors", {
      code: "V",
      name: "Vendor",
      address: "Salmiya",
    });
    const order = await call(admin, "orders", {
      reference: "CHAT-BROWSER",
      recipient: "Customer",
      address: "Salmiya",
      phone: "+96555555555",
      items: [{ vendorCode: "V", name: "Gift", quantity: 1 }],
    });
    await call(admin, "orders/" + order.id + "/action", {
      action: "assign",
      driver: driverId,
    });
    const opsPage = await admin.newPage(),
      driverPage = await driver.newPage(),
      errors = [];
    for (const p of [opsPage, driverPage])
      p.on("pageerror", (e) => errors.push(e.message));
    await opsPage.goto(url);
    await opsPage.locator('[data-view="chat"]').click();
    await opsPage.locator("[data-chat-thread]").click();
    const first = "Please use entrance B. <img src=x onerror=alert(1)>";
    await opsPage.locator("#chatCompose textarea").fill(first);
    await opsPage
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await opsPage.getByText("Message saved", { exact: true }).waitFor();
    await driverPage.goto(url);
    await driverPage
      .getByRole("button", { name: "Message operations", exact: true })
      .click();
    await driverPage
      .locator("#chatMessages")
      .getByText(first, { exact: true })
      .waitFor();
    assert.equal(await driverPage.locator("#chatMessages img").count(), 0);
    await driverPage.waitForFunction(
      async () => (await api("chat/inbox")).unread === 0,
    );
    await opsPage
      .locator("#chatCompose textarea")
      .fill("Draft survives refresh");
    // Store the reply, then lose its response. An explicit retry must not duplicate it.
    let lost = false;
    await driver.route("**/api/chat/**/messages", async (route) => {
      if (!lost && route.request().method() === "POST") {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    const reply = "Confirmed, I will use entrance B.";
    await driverPage.locator("#chatCompose textarea").fill(reply);
    await driverPage
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await driverPage
      .getByText(/Text retained. Choose Send message to retry/)
      .waitFor();
    assert.equal(
      await driverPage.locator("#chatCompose textarea").inputValue(),
      reply,
    );
    await driverPage
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await driverPage.getByText("Message saved", { exact: true }).waitFor();
    const conversation = await call(
      driver,
      "chat/" + order.id + "/" + driverId,
    );
    assert.equal(
      conversation.messages.filter((m) => m.body === reply).length,
      1,
    );
    await opsPage
      .locator("#chatMessages")
      .getByText(reply, { exact: true })
      .waitFor({ timeout: 25000 });
    assert.equal(
      await opsPage.locator("#chatCompose textarea").inputValue(),
      "Draft survives refresh",
    );
    await driverPage.locator('[data-view="orders"]').click();
    await opsPage
      .locator("#chatCompose textarea")
      .fill("Thank you. Please update me at arrival.");
    await opsPage
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await opsPage.getByText("Message saved", { exact: true }).waitFor();
    await driverPage.waitForFunction(
      () => document.querySelector(".chatUnread")?.textContent === "1",
      undefined,
      { timeout: 25000 },
    );
    await driverPage
      .getByRole("button", { name: "Message operations", exact: true })
      .click();
    await driverPage
      .locator("#chatMessages")
      .getByText("Thank you. Please update me at arrival.", { exact: true })
      .waitFor();
    await driverPage.screenshot({
      path: "/tmp/mawada-driver-chat.png",
      fullPage: true,
    });
    assert.equal(
      await driverPage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
    console.log(
      "Chat browser passed: operations-to-driver conversation, escaped message text, reply polling, preserved composition, lost-response retry without duplicates, unread badge and mobile layout.",
    );
  } finally {
    if (browser) await browser.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
