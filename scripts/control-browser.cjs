const { chromium } = require("playwright");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { spawn } = require("node:child_process");
(async () => {
  const root = path.resolve(__dirname, ".."),
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mawada-control-browser-"));
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_BACKEND: "sqlite",
      DATA_DIR: path.join(cwd, "data"),
      PORT: "0",
      SESSION_SECRET: "browser-test-secret-only-123456789012345",
      AUTO_BACKUP: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser,
    diagnosticPage,
    diagnostics = "";
  child.stderr.on("data", (b) => (diagnostics += b));
  try {
    const url = await new Promise((resolve, reject) => {
      child.once("exit", () =>
        reject(Error("Test server exited: " + diagnostics)),
      );
      child.stdout.on("data", (b) => {
        const m = String(b).match(/Delivery app listening (\d+)/);
        if (m) resolve("http://127.0.0.1:" + m[1]);
      });
    });
    for (let i = 0; i < 100; i++) {
      if ((await fetch(url + "/health/ready")).ok) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      headless: true,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
      geolocation: { latitude: 29.3759, longitude: 47.9774 },
      permissions: ["geolocation"],
    });
    await context.route("https://tile.openstreetmap.org/**", (r) => r.abort());
    const page = await context.newPage(),
      errors = [];
    diagnosticPage = page;
    page.on("pageerror", (e) => errors.push(e.message));
    const request = async (route, body) => {
      const r = body
        ? await context.request.post(url + "/api/" + route, { data: body })
        : await context.request.get(url + "/api/" + route);
      assert.equal(r.status(), 200, await r.text());
      return r.json();
    };
    const password = "browser-password-12345";
    await request("setup", {
      name: "Administrator",
      email: "admin@example.test",
      password,
    });
    await request("login", { email: "admin@example.test", password });
    await request("users", {
      name: "Delivery Driver",
      email: "driver@example.test",
      password,
      role: "driver",
    });
    await request("vendors", {
      code: "V1",
      name: "Gift Vendor",
      address: "Salmiya",
      phone: "+96555555555",
    });
    const today = new Date(Date.now() + 10800000).toISOString().slice(0, 10);
    const order = await request("orders", {
      reference: "BROWSER-CONTROL",
      recipient: "Test Customer",
      phone: "+96555555555",
      address: "Salmiya",
      deliveryDate: today,
      timeSlot: "09:00-12:00",
      items: [{ vendorCode: "V1", name: "Gift", quantity: 1 }],
    });
    await page.goto(url);
    await page.locator('[data-view="control"]').click();
    await page.getByRole("heading", { name: /active exceptions/ }).waitFor();
    assert.ok(
      (await page.locator("#controlBody").textContent()).includes(
        "Confirm vendor readiness",
      ),
    );
    await page.locator('[data-control-tab="planning"]').click();
    const commitment = page.locator("#commitment");
    await commitment.locator('[name="orderId"]').selectOption(order.id);
    await commitment.locator('[name="area"]').fill("Salmiya");
    await commitment
      .getByRole("button", { name: "Save delivery plan" })
      .click();
    await page
      .getByText("Delivery commitment saved", { exact: true })
      .waitFor();
    const driver = (await request("state")).users.find(
      (u) => u.role === "driver",
    );
    await page.locator('#bulkPlan [name="leg"]').selectOption("pickup");
    await page.locator('#bulkPlan [name="driverId"]').selectOption(driver.id);
    await page.locator("#selectPlan").click();
    await page
      .getByRole("button", { name: "Preview assignment", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Review assignment to Delivery Driver" })
      .waitFor();
    await page
      .getByRole("button", { name: "Confirm these assignments" })
      .click();
    await page
      .getByRole("heading", { name: "1 assigned / 1 selected" })
      .waitFor();
    await page.locator('[data-control-tab="performance"]').click();
    await page
      .getByRole("heading", { name: "Delivery performance", exact: true })
      .waitFor();
    await page.screenshot({
      path: "/tmp/mawada-performance.png",
      fullPage: true,
    });
    assert.ok(
      (await page.locator("#controlBody").textContent()).includes(
        "First-attempt success",
      ),
    );
    await page.locator('[data-control-tab="updates"]').click();
    await page
      .getByRole("heading", { name: "WhatsApp delivery updates" })
      .waitFor();
    await page.locator('[data-control-tab="readiness"]').click();
    await page
      .getByRole("heading", { name: "Operational readiness", exact: true })
      .waitFor();
    await page.screenshot({
      path: "/tmp/mawada-operations-control.png",
      fullPage: true,
    });
    // A save may succeed even when its response is lost; reconcile against fresh state.
    await page.locator('[data-view="assignments"]').click();
    await page.locator("#addPrintAwbs textarea").fill(order.awb);
    await page.locator("#addPrintAwbs button").click();
    await page.locator("#assignmentDriver").selectOption(driver.id);
    await page.locator("#assignmentLeg").selectOption("pickup");
    const actionUrl = "**/api/orders/" + order.id + "/action";
    await context.route(actionUrl, async (route) => {
      await route.fetch();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Fixture: response could not be confirmed",
          code: "SUPABASE_CONNECTION_FAILED",
        }),
      });
    });
    await page.locator("#printBatch").click();
    await page
      .getByText(
        /current pickup assignment confirmed after refresh; no retry needed/,
      )
      .waitFor();
    assert.equal(
      (await request("state")).orders[0].history.filter(
        (h) => h.event === "assign-pickups",
      ).length,
      1,
    );
    await context.unroute(actionUrl);
    // A failure before the write must remain unconfirmed and must not claim partial pickup assignment for delivery.
    await page.locator("#addPrintAwbs textarea").fill(order.awb);
    await page.locator("#addPrintAwbs button").click();
    await page.locator("#assignmentLeg").selectOption("delivery");
    await context.route(actionUrl, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Fixture: request not sent",
          code: "SUPABASE_CONNECTION_FAILED",
        }),
      }),
    );
    await page.locator("#printBatch").click();
    await page
      .getByText(
        /Assignment not confirmed; review the refreshed order before retrying/,
      )
      .waitFor();
    assert.ok(
      !(await page.locator("#assignmentResults").textContent()).includes(
        "partial pickup",
      ),
    );
    assert.equal((await request("state")).orders[0].driver, null);
    const compactReply = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/orders/" + order.id + "/action") &&
        r.status() === 200,
    );
    await context.unroute(actionUrl);
    await page.waitForFunction(() => !busy);
    await page.locator("#printBatch").click();
    await page.getByText(/delivery assigned/).waitFor();
    const assignmentResponse = await (await compactReply).json();
    assert.equal(assignmentResponse.proofs, undefined);
    assert.equal(assignmentResponse.items, undefined);
    assert.equal(assignmentResponse.driver, driver.id);
    await page.locator("#logout").click();
    await page.getByRole("heading", { name: "Welcome back" }).waitFor();
    await page.locator('#auth [name="email"]').fill("driver@example.test");
    await page.locator('#auth [name="password"]').fill(password);
    await page.locator("#auth button").click();
    await page.getByRole("heading", { name: "Suggested next stop" }).waitFor();
    await page.setViewportSize({ width: 412, height: 915 });
    await page.waitForFunction(() => !busy);
    await page
      .getByRole("button", { name: "Start pickup trip", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Verify items and record pickup",
        exact: true,
      })
      .waitFor();
    await page
      .getByRole("button", {
        name: "Verify items and record pickup",
        exact: true,
      })
      .click();
    const form = page.locator("#proofForm");
    await form.locator('[name="name"]').fill("Vendor Contact");
    await form.locator('[name="photo"]').setInputFiles({
      name: "proof.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1X8AAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await form.locator('[name="verifiedItems"]').check();
    await page.waitForFunction(async () =>
      (await ProofDrafts.all()).some(
        (r) => r.body.name === "Vendor Contact" && r.body.photo,
      ),
    );
    await context.setOffline(true);
    await form.getByRole("button", { name: "Save proof", exact: true }).click();
    await page.waitForFunction(async () =>
      (await ProofDrafts.all()).some((r) => r.body.capturedAt),
    );
    await page.waitForFunction(() => !busy);
    assert.equal(await page.locator("#proof").evaluate((el) => el.open), true);
    await context.setOffline(false);
    await page.reload();
    await page
      .getByRole("button", { name: "Review draft", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Review draft", exact: true })
      .click();
    await page
      .getByText(
        "Restored on-device draft. Review all details and submit when connected.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await form.locator('[name="name"]').inputValue(),
      "Vendor Contact",
    );
    assert.equal(
      await form.locator('[name="verifiedItems"]').isChecked(),
      true,
    );
    await page.evaluate(() => {
      IDBObjectStore.prototype.put = () => {
        throw new DOMException("Fixture quota exceeded", "QuotaExceededError");
      };
    });
    await form.getByRole("button", { name: "Save proof", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("#proof").open);
    assert.equal((await request("state")).orders[0].status, "Picked up");
    assert.equal(
      await page.evaluate(async () => (await ProofDrafts.all()).length),
      0,
    );
    await page.screenshot({
      path: "/tmp/mawada-driver-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      "Control browser passed: exception queue, commitments, bulk preview/confirm, performance, provider readiness, mobile next stop, offline proof persistence, reload/review, storage-quota fallback and successful explicit retry.",
    );
  } catch (e) {
    if (diagnosticPage) {
      console.error(
        (await diagnosticPage.locator("body").innerText()).slice(-7000),
      );
      await diagnosticPage.screenshot({
        path: "/tmp/mawada-browser-failure.png",
        fullPage: true,
      });
    }
    throw e;
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) {
      const done = new Promise((r) => child.once("exit", r));
      child.kill();
      await done;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
