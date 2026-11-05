const $ = (s) => document.querySelector(s),
  app = $("#app");
let state,
  view = "dashboard",
  proofOrder,
  proofStage,
  proofPickup,
  signed = false;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
async function api(url, body) {
  if (window.relayDemo) return window.relayDemo.request(url, body);
  const r = await fetch("/api/" + url, {
    method: body ? "POST" : "GET",
    headers:
      body && !(body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {},
    body:
      body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok && j.errors?.length)
    j.error +=
      " " +
      j.errors
        .slice(0, 5)
        .map((e) => "Row " + e.row + ": " + e.error)
        .join("; ");
  if (!r.ok)
    throw Object.assign(Error(j.error || "Request failed"), {
      status: r.status,
      code: j.code,
      duplicates: j.duplicates,
    });
  return j;
}
let toastTimer;
function toast(message, type = "success") {
  const el = $("#toast");
  clearTimeout(toastTimer);
  el.textContent = message;
  el.dataset.type = type;
  el.hidden = false;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  toastTimer = setTimeout(
    () => (el.hidden = true),
    type === "error" ? 8000 : 3500,
  );
}
let busy = false;
async function run(fn) {
  if (busy) return;
  busy = true;
  const trigger =
    document.activeElement instanceof HTMLButtonElement
      ? document.activeElement
      : null;
  if (trigger) {
    trigger.disabled = true;
    trigger.setAttribute("aria-busy", "true");
  }
  try {
    await fn();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    busy = false;
    if (trigger) {
      trigger.disabled = false;
      trigger.removeAttribute("aria-busy");
    }
  }
}
const symbols = {
  orders: "M3 6h18M3 12h18M3 18h18",
  plus: "M12 5v14M5 12h14",
  vendor: "M3 10l2-6h14l2 6M4 10v10h16V10M9 20v-7h6v7",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87",
  box: "M3 7l9-5 9 5v10l-9 5-9-5V7zm0 0l9 5 9-5M12 12v10M7.5 4.5l9 5",
  truck: "M3 6h11v12H3zM14 10h4l3 4v4h-7M5 18a2 2 0 1 0 4 0m7 0a2 2 0 1 0 4 0",
  check: "M5 12l4 4L19 6",
  clock: "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  warehouse: "M3 21V9l9-6 9 6v12M7 21V11h10v10M7 15h10M7 18h10",
  alert: "M12 8v5m0 3v1M10 3L2 19h20L14 3z",
};
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${symbols[name] || symbols.box}"/></svg>`;
const statuses = [
  "Created",
  "Picked up",
  "At warehouse",
  "Out for delivery",
  "Delivery failed",
  "Delivered",
];
const statusClass = (status) =>
  ({
    Created: "created",
    "Picked up": "picked",
    "At warehouse": "warehouse",
    "Out for delivery": "transit",
    "Delivery failed": "failed",
    Delivered: "delivered",
  })[status] || "created";
let searchQuery = "",
  statusFilter = "",
  sortOrder = "newest",
  selectedOrder = null;
const field = (name, label, type = "text") =>
  `<label>${label}<input name="${name}" type="${type}" required></label>`;
async function boot() {
  try {
    const s = await api("setup");
    if (s.required) return auth(true, s.keyRequired);
    try {
      state = await api("state");
      render();
    } catch (error) {
      if (error.status === 401) auth(false);
      else throw error;
    }
  } catch (error) {
    app.innerHTML = `<section class="auth"><h1>App setup needs attention</h1><p>${esc(error.message)}</p><p>Your data has not been moved or replaced. On-device proof drafts are retained; reconnect and sign in with the same account to review them.</p><button id="retryStartup">Try again</button><a class="primaryLink" href="/demo">Try the sample-data demo</a><p class="muted">The demo is separate from your operational data. Share the error code with your administrator: ${esc(error.code || "CONNECTION_ERROR")}</p></section>`;
    $("#retryStartup").onclick = boot;
  }
}

function auth(setup, keyRequired = false) {
  app.innerHTML = `<section class="auth"><h1>${setup ? "Set up Mawada Experience Managers" : "Welcome back"}</h1><p>${setup ? "Create your administrator account. Use a password of at least 12 characters." : "Sign in to your delivery workspace."}</p><form id="auth">${setup ? field("name", "Your name") : ""}${setup && keyRequired ? field("setupKey", "Setup key (Hostinger SETUP_KEY)", "password") : ""}${field("email", "Email", "email")}${field("password", "Password", "password")}<button>${setup ? "Create administrator" : "Sign in"}</button></form></section>`;
  if (!setup && !window.relayDemo) {
    app
      .querySelector(".auth")
      .insertAdjacentHTML(
        "beforeend",
        '<details><summary>Forgot your password?</summary><form id="requestRecovery"><label>Account email<input name="email" type="email" required autocomplete="email"></label><button>Email a reset link</button><p role="status" id="recoveryStatus"></p></form></details>',
      );
    $("#requestRecovery").onsubmit = (e) => {
      e.preventDefault();
      run(async () => {
        const result = await api("recovery/request", {
          email: new FormData(e.target).get("email"),
        });
        $("#recoveryStatus").textContent = result.message;
      });
    };
  }
  $("#auth").onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      await api(
        setup ? "setup" : "login",
        Object.fromEntries(new FormData(e.target)),
      );
      if (setup) auth(false);
      else boot();
    });
  };
}
function render() {
  labelReader?.reset();
  labelReader = null;
  releaseFleetMap();
  const admin = state.user.role === "admin",
    ops = admin || state.user.role === "operations";
  let pages = [
    ...(ops
      ? [
          { id: "dashboard", label: "Dashboard", symbol: "warehouse" },
          { id: "control", label: "Operations control", symbol: "alert" },
        ]
      : []),
    { id: "orders", label: "Orders", symbol: "orders" },
    { id: "labels", label: "AWB printing", symbol: "box" },
    ...(canChat()
      ? [
          {
            id: "chat",
            label: state.user.role === "driver" ? "Messages" : "Driver chat",
            symbol: "users",
          },
        ]
      : []),
    ...(ops
      ? [
          { id: "create", label: "New order / Excel", symbol: "plus" },
          { id: "assignments", label: "Scan & assign", symbol: "truck" },
          { id: "vendors", label: "Vendors", symbol: "vendor" },
          { id: "reports", label: "Reports", symbol: "orders" },
        ]
      : []),
    ...(admin ? [{ id: "users", label: "Team access", symbol: "users" }] : []),
    { id: "settings", label: "Settings", symbol: "vendor" },
  ];
  pages = pages.filter(
    (p) =>
      !{
        assignments: "work",
        control: "dashboard",
        dashboard: "dashboard",
        reports: "reports",
        create: "create",
        vendors: "vendors",
      }[p.id] ||
      MawadaAccess.allowed(
        state.user,
        {
          assignments: "work",
          control: "dashboard",
          dashboard: "dashboard",
          reports: "reports",
          create: "create",
          vendors: "vendors",
        }[p.id],
      ),
  );
  if (!pages.some((p) => p.id === view)) view = "orders";
  $("#logout").hidden = false;
  const titles = {
    chat: "Keep your team connected.",
    control: "Keep every delivery promise in view.",
    assignments: "The right order. The right driver.",
    labels: "Ready to label. Ready to deliver.",
    dashboard: "A beautiful overview of your day.",
    orders: "Every delivery. One clear view.",
    create: "A new journey starts here.",
    vendors: "Your pickup network.",
    users: "The people who keep it moving.",
    reports: "The full story of every order.",
    settings: "Make Mawada yours.",
  };
  app.innerHTML = `<div class="appShell"><aside class="workspaceSidebar"><div class="workspaceLabel">WORKSPACE <span class="liveDot"></span></div><div class="workspaceName">Mawada delivery<small>One warehouse · Online delivery</small></div><nav aria-label="Workspace navigation">${pages.map((p) => `<button data-view="${p.id}" class="${view === p.id ? "active" : ""}" ${view === p.id ? 'aria-current="page"' : ""}>${icon(p.symbol)}<span>${p.label}</span>${p.id === "orders" ? `<span class="navCount">${state.orders.length}</span>` : p.id === "chat" ? '<span class="chatUnread" hidden></span>' : ""}</button>`).join("")}</nav><div class="sidebarNote">${icon("check")}<div>Complete orders only<small>Every item checked before dispatch.</small></div></div><div class="userCard"><span class="avatar">${esc(state.user.name.slice(0, 2).toUpperCase())}</span><div><strong>${esc(state.user.name)}</strong><small>${esc(state.user.role)}</small></div></div></aside><div class="workspaceMain"><div class="pageHeading"><div><div class="eyebrow">OPERATIONS / ${esc(pages.find((p) => p.id === view).label.toUpperCase())}</div><h1>${titles[view]}</h1><p class="muted">${view === "orders" ? "Track pickups, consolidate with confidence, and keep deliveries moving." : "Everything your team needs, without the extra steps."}</p></div>${ops && MawadaAccess.allowed(state.user, "create") && view === "orders" ? `<button class="primary" id="quickCreate">${icon("plus")} Create order</button>` : ""}</div>${admin ? `<div class="storageNote"><span class="liveDot"></span>${state.storageBackend === "supabase" ? "Cloud database: Supabase" : state.storageBackend === "demo" ? "Sample demo · browser only" : "Local trial database"}</div>` : ""}${view === "orders" ? `<div class="stats">${statuses.map((s, i) => `<button class="stat ${statusClass(s)} ${statusFilter === s ? "selected" : ""}" data-status="${s}" aria-pressed="${statusFilter === s}"><div class="statTop"><span>${s}</span>${icon(["box", "truck", "warehouse", "truck", "alert", "check"][i])}</div><div class="statBottom"><strong>${state.orders.filter((o) => o.status === s).length}</strong><span>View orders</span></div></button>`).join("")}</div>` : ""}${ops && view === "orders" ? '<div id="fleetPanel"></div>' : ""}<div id="content"></div><footer class="workspaceFooter"><span>Mawada · Kuwait delivery</span><span>Pickup → Warehouse → Delivery</span></footer></div></div>`;
  document.querySelectorAll("[data-view]").forEach(
    (b) =>
      (b.onclick = () => {
        view = b.dataset.view;
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }),
  );
  if ($("#quickCreate"))
    $("#quickCreate").onclick = () => {
      view = "create";
      render();
    };
  document.querySelectorAll("[data-status]").forEach(
    (b) =>
      (b.onclick = () => {
        statusFilter =
          statusFilter === b.dataset.status ? "" : b.dataset.status;
        render();
      }),
  );
  const c = $("#content");
  if (view === "orders") orders(c);
  if (view === "create") create(c);
  if (view === "vendors") vendors(c);
  if (view === "users") users(c);
  if (view === "reports") renderReports(c);
  if (view === "settings") renderAppearance(c);
  if (view === "labels") renderLabelWorkspace(c);
  if (view === "assignments") renderAssignmentWorkspace(c);
  if (view === "dashboard") renderExecutiveDashboard(c);
  if (view === "control") renderControlWorkspace(c);
  if (view === "chat") renderChat(c);
  if (ops && MawadaAccess.allowed(state.user, "dashboard") && view === "orders")
    renderFleet($("#fleetPanel"));
}
async function refresh(message = "Workspace updated") {
  state = await api("state");
  render();
  toast(message);
  reconcileTracking();
}
function bindForm(id, path, transform = (x) => x) {
  $(id).onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      const result = await api(
        path,
        transform(Object.fromEntries(new FormData(e.target))),
      );
      if (path === "orders") {
        view = "orders";
        searchQuery = "";
        statusFilter = "";
        selectedOrder = result.id || null;
        sortOrder = "newest";
      }
      await refresh(
        path === "orders"
          ? "Order created successfully"
          : path === "vendors"
            ? "Vendor location saved"
            : path === "users"
              ? "Team member created"
              : "Workspace updated",
      );
    });
  };
}
function vendors(c) {
  c.innerHTML = `<section><h2>Add vendor pickup location</h2><form id="vendor"><div class="grid">${field("code", "Vendor code")}${field("name", "Vendor name")}${field("address", "Pickup address")}${field("phone", "Contact phone")}</div><button>Save vendor</button></form></section>${state.vendors.map((v) => `<section><b>${esc(v.name)} · ${esc(v.code)}</b><p>${esc(v.address)} · ${esc(v.phone)}</p></section>`).join("")}`;
  bindForm("#vendor", "vendors");
}
function users(c) {
  const checklist = (user) =>
    `<div class="permissionChecklist">${Object.entries(MawadaAccess.labels)
      .map(
        ([key, label]) =>
          `<label><input type="checkbox" name="permissions" value="${key}" ${MawadaAccess.allowed(user, key) ? "checked" : ""} ${!MawadaAccess.defaults[user.role]?.includes(key) || user.role === "admin" ? "disabled" : ""}> ${esc(label)}</label>`,
      )
      .join("")}</div>`;
  c.innerHTML = `<section><h2>Team access</h2><p>Administrators have full access and manage the team. Operations can manage all orders. Warehouse handles receipt and warehouse actions. Drivers access only assigned orders and available AWB claims. Checklists restrict access within each role; they cannot expand it.</p>${window.relayDemo ? '<p class="demoAccountNotice">This is a sample demo. Team accounts here cannot sign in. <a href="/">Open the live app to create real accounts</a>.</p>' : ""}<h3>Create team member</h3><form id="user"><div class="grid">${field("name", "Name")}${field("email", "Email", "email")}${field("password", "Password (12+ characters)", "password")}<label>Role<select name="role">${["operations", "warehouse", "driver", "admin"].map((r) => `<option>${r}</option>`).join("")}</select></label></div><div id="newPermissions"></div><button ${window.relayDemo ? "disabled" : ""}>Create user</button></form></section>${state.users.map((u) => `<section><h3>${esc(u.name)} · ${esc(u.role)}</h3><p>${esc(u.email || "Sample account")}</p><details><summary>Edit account</summary><form data-edit-user="${esc(u.id)}"><div class="grid"><label>Name<input name="name" value="${esc(u.name)}" required></label><label>Email<input name="email" type="email" value="${esc(u.email || "")}" required></label><label>Role<select name="role">${["admin", "operations", "warehouse", "driver"].map((role) => `<option ${role === u.role ? "selected" : ""}>${role}</option>`).join("")}</select></label><label>New password (leave blank to keep)<input name="password" type="password" minlength="12" autocomplete="new-password"></label></div><button ${window.relayDemo ? "disabled" : ""}>Save user</button></form></details>${u.id !== state.user.id ? `<button class="ghost" data-delete-user="${esc(u.id)}" ${window.relayDemo ? "disabled" : ""}>Delete user</button>` : ""}<form data-user-permissions="${esc(u.id)}">${checklist(u)}${u.role === "admin" ? "<p>Administrator access is fixed.</p>" : `<button ${window.relayDemo ? "disabled" : ""}>Save access</button>`}</form></section>`).join("")}`;
  c.querySelectorAll("[data-edit-user]").forEach(
    (f) =>
      (f.onsubmit = (e) => {
        e.preventDefault();
        run(async () => {
          await api(
            "users/" + encodeURIComponent(f.dataset.editUser) + "/edit",
            Object.fromEntries(new FormData(f)),
          );
          await refresh("User updated");
        });
      }),
  );
  c.querySelectorAll("[data-delete-user]").forEach(
    (b) =>
      (b.onclick = () => {
        if (
          !confirm(
            "Delete this user’s access? Historical delivery records will be kept.",
          )
        )
          return;
        run(async () => {
          await api(
            "users/" + encodeURIComponent(b.dataset.deleteUser) + "/delete",
            {},
          );
          await refresh("User deleted");
        });
      }),
  );
  const form = c.querySelector("#user");
  const update = () =>
    (c.querySelector("#newPermissions").innerHTML = checklist({
      role: form.elements.role.value,
    }));
  update();
  form.elements.role.onchange = update;
  form.onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      const fields = new FormData(form);
      const body = Object.fromEntries(fields);
      body.permissions = fields.getAll("permissions");
      await api("users", body);
      await refresh(
        "Team member created. They can sign in to the live app using this email and password.",
      );
    });
  };
  c.querySelectorAll("[data-user-permissions]").forEach(
    (f) =>
      (f.onsubmit = (e) => {
        e.preventDefault();
        run(async () => {
          await api(
            "users/" +
              encodeURIComponent(f.dataset.userPermissions) +
              "/permissions",
            { permissions: new FormData(f).getAll("permissions") },
          );
          await refresh("Access updated");
        });
      }),
  );
}

function create(c) {
  c.innerHTML = `<section><h2>Create order</h2><form id="order"><div class="grid">${field("reference", "Your order reference")}${field("recipient", "Recipient name")}${field("phone", "Phone (+965 followed by 8 digits)")}${field("address", "Delivery address")}<label>Delivery date<input name="deliveryDate" type="date"></label><label>Time window (Kuwait)<input name="timeSlot" placeholder="09:00-12:00"></label><label>Area<input name="area" maxlength="100" placeholder="e.g. Salmiya"></label></div><label class="check"><input name="whatsappConsent" type="checkbox"> Customer agreed to WhatsApp delivery updates</label><h3>Items and pickups</h3><div id="items"></div><button type="button" id="add">Add item</button><button>Create order</button></form></section><section><h2>Upload Excel (.xlsx)</h2><a class="primaryLink" href="${window.relayDemo ? "/Mawada-CMS-Order-Template.xlsx" : "/api/import/template"}" download="Mawada-CMS-Order-Template.xlsx">Download CMS Excel template</a><p class="muted">Includes required/optional fields, multi-item example rows and CMS instructions. Remove example rows before import. Template download requires a live account with order import access.</p><label>Export format<select id="importFormat"><option value="mawada">Mawada CMS · deliveries due today (Kuwait)</option><option value="template">Mawada item-row template</option></select></label><p>Mawada: use named columns for Order Number, Recipient Delivery Date, Recipient Name, Recipient Phone, Recipient Address, Vendor Name, Item Details and Quantity. Only deliveries due today in Kuwait are selected. Use one row per item. For the Mawada template, use reference, recipient, phone, address, vendorCode, name, quantity in that order.</p><input id="excel" type="file" accept=".xlsx"><button id="preview">Validate and preview</button><div id="previewResult"></div></section>`;
  if (state.user.role === "admin" && !window.relayDemo) {
    c.insertAdjacentHTML(
      "afterbegin",
      `<section class="chartCard"><div class="eyebrow">PRESENTATION READY</div><h2>Load fictional demo orders</h2><p>Add 24 clearly labelled orders for yesterday, today and tomorrow, two fictional vendors and three sample drivers. Includes pending pickups, warehouse-ready orders, active deliveries, completed deliveries and late examples. No customer messages are sent. Sample drivers do not have login credentials.</p><button id="loadDemoOrders">Load demo orders</button><p>Existing orders are kept. Repeating this on the same day does not duplicate the sample orders.</p></section>`,
    );
    c.querySelector("#loadDemoOrders").onclick = () =>
      run(async () => {
        const result = await api("demo-orders", {});
        view = "dashboard";
        await refresh(result.created + " fictional demo orders added");
      });
  }
  const updateRemove = () =>
    document
      .querySelectorAll(".removeItem")
      .forEach(
        (button) => (button.disabled = $("#items").children.length === 1),
      );
  const add = () => {
    $("#items").insertAdjacentHTML(
      "beforeend",
      `<div class="grid item"><label>Vendor<select class="vendor">${state.vendors.map((v) => `<option value="${esc(v.code)}">${esc(v.name)} (${esc(v.code)})</option>`).join("")}</select></label><label>Item<input class="name" required></label><label>Quantity<input class="quantity" type="number" min="1" step="1" value="1" required></label><button type="button" class="removeItem ghost" aria-label="Remove item">Remove item</button></div>`,
    );
    updateRemove();
  };
  add();
  $("#add").onclick = add;
  $("#items").onclick = (event) => {
    const button = event.target.closest(".removeItem");
    if (button && $("#items").children.length > 1) {
      button.closest(".item").remove();
      updateRemove();
    }
  };
  bindForm("#order", "orders", (b) => ({
    ...b,
    whatsappConsent: b.whatsappConsent === "on",
    items: [...document.querySelectorAll("#items .item")].map((i) => ({
      vendorCode: i.querySelector(".vendor").value,
      name: i.querySelector(".name").value,
      quantity: Number(i.querySelector(".quantity").value),
    })),
  }));
  if (!window.relayDemo) {
    $("#preview").insertAdjacentHTML(
      "beforebegin",
      `<details><summary>Saved CMS column mapping</summary><p>Enter your export’s exact column headings. Leave blank to use the standard Mawada headings. Mapping is saved for your account; this still needs validation against your actual CMS export.</p><form id="mappingForm"><div class="grid">${["date", "reference", "recipient", "phone", "address", "vendor", "item", "quantity", "slot", "amount", "bell", "directions", "card", "occasion", "message"].map((k) => `<label>${k}<input name="${k}" value="${esc(state.user.importMapping?.[k] || "")}" maxlength="120"></label>`).join("")}</div><button>Save mapping</button></form></details><label class="check"><input type="checkbox" id="skipDuplicates"> Skip existing order references after review</label><div id="importErrors" role="alert"></div>`,
    );
    $("#mappingForm").onsubmit = (e) => {
      e.preventDefault();
      run(async () => {
        const mapping = Object.fromEntries(
          [...new FormData(e.target)].filter(([, v]) => v.trim()),
        );
        await api("import/mapping", { mapping });
        state = await api("state");
        toast("CMS mapping saved for this account");
      });
    };
  }
  $("#preview").onclick = () =>
    run(async () => {
      const file = $("#excel").files[0];
      if (!file) throw Error("Select a workbook");
      const f = new FormData();
      f.append("file", file);
      const format = $("#importFormat").value;
      const suffix =
        "&skipDuplicates=" + ($("#skipDuplicates")?.checked ? "yes" : "no");
      let result;
      try {
        result = await api("import?format=" + format + suffix, f);
      } catch (e) {
        if ($("#importErrors"))
          $("#importErrors").textContent =
            e.message +
            (e.duplicates?.length
              ? " " +
                e.duplicates
                  .map((d) => d.reference + ": " + d.reason)
                  .join("; ")
              : "");
        throw e;
      }
      if ($("#importErrors")) $("#importErrors").textContent = "";
      $("#previewResult").innerHTML =
        `<p>${result.duplicates?.length ? result.duplicates.length + " existing references excluded · " : ""}${result.count} valid orders${result.today ? " due " + esc(result.today) + " in Kuwait · " + result.excluded.length + " rows excluded" : ""}</p>${result.excluded?.length ? `<details><summary>Excluded rows</summary>${result.excluded.map((row) => `<p>Row ${row.row}: ${esc(row.reason)}</p>`).join("")}</details>` : ""}${result.orders.map((o) => `<section class="importPreview"><strong>${esc(o.reference)} · ${esc(o.recipient)}</strong><p>${esc(o.phone)} · ${esc(o.address)}</p><p>${o.items.map((i) => esc(i.name) + " × " + i.quantity + " · " + esc(i.vendor?.name || i.vendorCode)).join("<br>")}</p>${o.source === "Mawada CMS" ? `<p>${esc(o.deliveryDate)} · ${esc(o.timeSlot || "No slot provided")} · ${o.amountFils == null ? "Value not provided" : (o.amountFils / 1000).toFixed(3) + " KWD"}</p><p>Ring bell: ${o.ringBell == null ? "Not provided" : o.ringBell ? "Yes" : "No"} · Card: ${o.cardAvailable == null ? "Not provided" : o.cardAvailable ? "Yes" : "No"}</p><p>${esc(o.extraDirections || "No extra directions")}</p><p>Occasion: ${esc(o.occasion?.value || "Unknown")} ${o.occasion?.needsReview ? "· Requires review" : ""}</p>` : ""}</section>`).join("")}<button id="confirm" ${result.count ? "" : "disabled"}>Confirm import</button>`;
      $("#confirm").onclick = () =>
        run(async () => {
          await api("import?confirm=yes&format=" + format + suffix, f);
          view = "orders";
          await refresh();
        });
    });
}
function nextStep(o) {
  return (
    {
      Created: "Collect items from each vendor",
      "Picked up": "Check items into the warehouse",
      "At warehouse": "Verify the full manifest and dispatch",
      "Out for delivery": "Capture proof at the recipient’s door",
      "Delivery failed": o.returned
        ? "Ready for rescheduling"
        : "Confirm items returned to the warehouse",
      Delivered: "Delivery complete · proof recorded",
    }[o.status] || ""
  );
}
function orderDeliveryNotes(o) {
  if (o.source !== "Mawada CMS") return "";
  return `<div class="orderNotes"><strong>Delivery instructions</strong><p>${o.deliveryDate ? esc(o.deliveryDate) : ""} ${esc(o.timeSlot || "")} · Order amount ${o.amountFils == null ? "not provided" : (o.amountFils / 1000).toFixed(3) + " KWD"}</p><p>Ring bell: ${o.ringBell == null ? "Not provided" : o.ringBell ? "Yes" : "No"} · Card available: ${o.cardAvailable == null ? "Not provided" : o.cardAvailable ? "Yes" : "No"}</p><p>${esc(o.extraDirections || "No extra directions")}</p><p>Occasion: ${esc(o.occasion?.value || "Unknown")}${o.occasion?.needsReview ? " · Unconfirmed suggestion" : ""}</p>${["admin", "operations"].includes(state.user.role) ? `<form class="occasionReview" data-order="${o.id}"><label>Review occasion<input name="occasion" maxlength="120" required value="${esc(o.occasion?.value || "")}" placeholder="e.g. Birthday or Unknown"></label><button>Confirm occasion</button></form>` : ""}</div>`;
}
function journey(o) {
  const active =
    {
      Created: 0,
      "Picked up": 1,
      "At warehouse": 1,
      "Out for delivery": 2,
      "Delivery failed": 2,
      Delivered: 3,
    }[o.status] ?? 0;
  return `<ol class="journey" aria-label="Order progress">${["Pickup", "Warehouse", "On the road", "Delivered"].map((label, i) => `<li class="${i < active || (i === 3 && active === 3) ? "done" : i === active ? "current" : ""}"><span>${i < active || (i === 3 && active === 3) ? icon("check") : i + 1}</span><small>${label}</small></li>`).join("")}</ol>`;
}
function orders(c) {
  pendingOrderRefresh = false;
  const manager = ["admin", "operations"].includes(state.user.role),
    warehouse = ["admin", "warehouse"].includes(state.user.role);
  const drivers = state.users.filter((u) => u.role === "driver");
  const driverSelect = () =>
    `<select name="driver" required><option value="">Choose driver</option>${drivers.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select>`;
  const button = (o, action, label, extra = "") =>
    `<button data-order="${o.id}" data-action="${action}" ${extra}>${label}</button>`;
  if (!selectedOrder && state.orders.length) selectedOrder = state.orders[0].id;
  c.innerHTML = `${state.user.role === "driver" ? '<div id="driverTools"></div>' : ""}<div class="boardHeading"><div><h2>Order board</h2><p class="muted" id="resultCount"></p></div><button class="ghost" id="expandOrders">Expand all</button></div><div class="orderToolbar"><label class="searchField">${icon("search")}<input id="orderSearch" type="search" aria-label="Search orders" placeholder="Search AWB, recipient, vendor or reference…" value="${esc(searchQuery)}"></label><label class="filterField"><span class="sr-only">Filter by status</span><select id="statusFilter" aria-label="Filter by status"><option value="">All statuses</option>${statuses.map((s) => `<option ${statusFilter === s ? "selected" : ""}>${s}</option>`).join("")}</select></label><label class="filterField"><span class="sr-only">Sort orders</span><select id="orderSort" aria-label="Sort orders"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="reference">Order reference</option></select></label></div><section id="noResults" class="emptyState" hidden>${icon("search")}<h3>No matching orders</h3><p class="muted">Try a different reference or clear your filters.</p><button id="clearFilters" class="secondary">Clear filters</button></section><div id="orderList">${state.orders
    .map(
      (
        o,
      ) => `<section class="orderCard" data-id="${o.id}" data-status-value="${esc(o.status)}" data-search="${esc([o.awb, o.reference, o.recipient, o.address, o.phone, ...o.items.map((i) => i.vendor.name), state.users.find((u) => u.id === o.driver)?.name || ""].join(" ").toLowerCase())}">
 <div class="orderTop"><div class="orderIdentity"><span class="orderIcon">${icon("box")}</span><div><span class="overline">AIR WAYBILL</span><button class="awbLink" data-open-awb="${esc(o.id)}">${esc(o.awb)}</button><small>Ref. ${esc(o.reference)}</small></div></div><span class="badge ${statusClass(o.status)}">${esc(o.status)}</span></div>
 <div class="orderSummary"><div class="orderDestination"><h3>${esc(o.recipient)}</h3><p>${esc(o.address)}</p><a href="tel:${esc(o.phone)}">${esc(o.phone)}</a></div><div class="orderFacts"><span>${o.pickups.length} vendor pickups</span><span>${o.items.length} item lines · ${o.items.reduce((n, i) => n + i.quantity, 0)} units</span></div></div>
 ${
   o.demoData
     ? o.items
         .filter((i) => safeProofImage(i.photo))
         .map(
           (i) =>
             `<figure><img class="demoItemPhoto" src="${i.photo}" alt="Demo · ${esc(i.name)}"><figcaption class="sampleMediaNote">Fictional sample item · ${esc(i.name)}</figcaption></figure>`,
         )
         .join("")
     : ""
 }
 ${orderDeliveryNotes(o)}
 ${journey(o)}
 ${canChat() && !window.relayDemo && !o.demoData ? `<button class="ghost" data-order-chat="${esc(o.id)}">${state.user.role === "driver" ? "Message operations" : "Chat with driver"}</button>` : ""}
 <div class="orderActionRow"><span class="nextStep">${icon(o.status === "Delivered" ? "check" : "clock")}${esc(nextStep(o))}</span>${button(o, "label", "Print AWB label")}</div>
 ${o.demoData ? '<p class="demoAccountNotice">FICTIONAL DEMO · simulated milestones/proof · do not dispatch</p>' : ""}
 <details class="orderWorkflow" ${selectedOrder === o.id ? "open" : ""}><summary><span>${icon("orders")} Manage workflow</span><span>${o.items.filter((i) => i.received).length}/${o.items.length} items received</span></summary><div class="orderBody">
 <p class="assignmentLabel">Delivery driver: ${esc(state.users.find((u) => u.id === o.driver)?.name || (o.driver ? "Assigned" : "Unassigned"))}${o.deliveryDate ? " · Scheduled " + esc(o.deliveryDate) : ""}</p>
 <h3>Vendor pickups</h3>${o.pickups
   .map(
     (
       p,
     ) => `<div class="card"><b>${esc(p.vendor.name)}</b><p>${esc(p.vendor.address)} · ${esc(p.vendor.phone)}</p><span class="badge">${p.completed ? "Completed" : "Awaiting pickup"}</span><p>Pickup driver: ${esc(state.users.find((u) => u.id === p.driver)?.name || (p.driver ? "Assigned" : "Unassigned"))}</p>
 ${o.items
   .filter((i) => i.vendor.id === p.vendor.id)
   .map(
     (i) =>
       `<p>${esc(i.name)} × ${i.quantity}${i.source ? " · " + esc(i.source) : ""}</p>`,
   )
   .join("")}
 ${manager && !p.completed ? `<form class="taskAssign" data-order="${o.id}" data-pickup="${p.id}">${driverSelect()}<button>Assign pickup driver</button></form>` : ""}
 ${pickupTripControls(o, p, manager, button)}
 ${!p.completed && (manager || (state.user.role === "driver" && p.driver === state.user.id && RelayOperations.activeTrips(o).some((t) => t.kind === "pickup" && t.pickupId === p.id))) ? button(o, "pickup", "Verify items and record pickup", `data-pickup="${p.id}"`) : ""}
 ${p.legacy ? "<small>Historical pickup: separate vendor proof was not recorded.</small>" : ""}</div>`,
   )
   .join("")}
 <h3>Warehouse manifest</h3>${o.items.map((i) => `<div class="item row"><span>${i.received ? "✓ Received" : "○ Awaiting receipt"} · ${esc(i.name)} × ${i.quantity}<small>${esc(i.vendor.name)}</small></span>${warehouse && !i.received && ["Created", "Picked up", "At warehouse"].includes(o.status) ? button(o, "receive", "Receive item", `data-item="${i.id}"`) : ""}</div>`).join("")}
 ${warehouse && ["Created", "Picked up", "At warehouse"].includes(o.status) ? `<details><summary>Add an item already at the warehouse</summary><p>This adds a physically received item to this order. Check its order reference before saving.</p><form class="addItem" data-order="${o.id}"><label>Vendor<select name="vendorCode">${state.vendors.map((v) => `<option value="${esc(v.code)}">${esc(v.name)}</option>`).join("")}</select></label>${field("name", "Item name")}${field("quantity", "Quantity", "number")}<button>Add received item</button></form></details>` : ""}
 ${manager && !["Delivered", "Out for delivery"].includes(o.status) ? `<form class="deliveryAssign" data-order="${o.id}"><label>Delivery driver${driverSelect()}</label><button>Assign delivery driver</button></form>` : ""}
 ${o.status === "At warehouse" && (manager || (state.user.role === "driver" && o.driver === state.user.id)) ? button(o, "Out for delivery", state.user.role === "driver" ? "Start delivery trip" : "Verify manifest and dispatch") : ""}
 ${o.status === "Out for delivery" && (manager || (state.user.role === "driver" && o.driver === state.user.id)) ? deliveryTripControls(o, button) + button(o, "Delivered", "Record delivery") + button(o, "fail", "Delivery unsuccessful") : ""}
 ${o.status === "Delivery failed" ? `<p>Latest failure: ${esc(o.attempts?.at(-1)?.reason)}</p><p>${o.returned ? "Returned to warehouse" : "Awaiting warehouse return confirmation"}</p>${warehouse && !o.returned ? button(o, "return", "Confirm physical return") : ""}${manager && o.returned ? `<form class="reschedule" data-order="${o.id}">${field("date", "New delivery date", "date")}<button>Reschedule</button></form>` : ""}` : ""}
 <details><summary>History and proof</summary>${o.history.map((h) => `<p>${esc(h.event)} · ${esc(h.by || "")} · ${new Date(h.at).toLocaleString("en-GB", { timeZone: "Asia/Kuwait" })}${h.reason ? " · " + esc(h.reason) : ""}${h.date ? " · " + esc(h.date) : ""}${h.item ? " · item " + esc(h.item) : ""}</p>`).join("")}${(o.proofs || []).map((p) => `<p>${esc(p.stage)} · ${esc(p.vendor || "")} · ${esc(p.name)} · GPS ${p.lat}, ${p.lng}</p><img width="180" src="${p.photo}" alt="Handover photo">${p.signature ? `<img width="180" src="${p.signature}" alt="Recipient signature">` : ""}`).join("")}</details></div></details></section>`,
    )
    .join("")}</div>`;
  c.querySelectorAll("[data-order-chat]").forEach(
    (b) => (b.onclick = () => openDriverChat(b.dataset.orderChat)),
  );
  $("#orderSort").value = sortOrder;
  const applyFilters = () => {
    const cards = [...document.querySelectorAll("#orderList > .orderCard")];
    cards.forEach(
      (card) =>
        (card.hidden = Boolean(
          (statusFilter && card.dataset.statusValue !== statusFilter) ||
          (searchQuery.trim() &&
            !card.dataset.search.includes(searchQuery.trim().toLowerCase())),
        )),
    );
    const count = cards.filter((card) => !card.hidden).length;
    $("#resultCount").textContent =
      `Showing ${count} of ${cards.length} ${cards.length === 1 ? "order" : "orders"}`;
    $("#noResults").hidden = count !== 0;
    document.querySelectorAll("[data-status]").forEach((b) => {
      b.classList.toggle("selected", b.dataset.status === statusFilter);
      b.setAttribute("aria-pressed", String(b.dataset.status === statusFilter));
    });
    cards
      .sort((a, b) => {
        const one = state.orders.find((o) => o.id === a.dataset.id),
          two = state.orders.find((o) => o.id === b.dataset.id);
        if (sortOrder === "reference")
          return one.reference.localeCompare(two.reference);
        const date = new Date(two.history[0].at) - new Date(one.history[0].at);
        return sortOrder === "oldest" ? -date : date;
      })
      .forEach((card) => $("#orderList").append(card));
  };
  $("#orderSearch").oninput = (e) => {
    searchQuery = e.target.value;
    applyFilters();
  };
  $("#statusFilter").onchange = (e) => {
    statusFilter = e.target.value;
    applyFilters();
  };
  $("#orderSort").onchange = (e) => {
    sortOrder = e.target.value;
    applyFilters();
  };
  $("#clearFilters").onclick = () => {
    searchQuery = "";
    statusFilter = "";
    $("#orderSearch").value = "";
    $("#statusFilter").value = "";
    applyFilters();
    $("#orderSearch").focus();
  };
  $("#expandOrders").onclick = () => {
    const details = [...document.querySelectorAll(".orderWorkflow")].filter(
      (d) => !d.closest("section").hidden,
    );
    const open = details.some((d) => !d.open);
    details.forEach((d) => (d.open = open));
    $("#expandOrders").textContent = open ? "Collapse all" : "Expand all";
  };
  document.querySelectorAll(".orderWorkflow").forEach((d) =>
    d.addEventListener("toggle", () => {
      if (d.open) selectedOrder = d.closest("section").dataset.id;
    }),
  );
  applyFilters();
  if (state.user.role === "driver") renderDriverPanel($("#driverTools"));
  for (const [selector, action] of [
    [".taskAssign", "assign-pickup"],
    [".deliveryAssign", "assign"],
    [".addItem", "add-item"],
    [".reschedule", "reschedule"],
    [".occasionReview", "review-occasion"],
  ])
    document.querySelectorAll(selector).forEach(
      (f) =>
        (f.onsubmit = (e) => {
          e.preventDefault();
          run(async () => {
            await api("orders/" + f.dataset.order + "/action", {
              action,
              pickup: f.dataset.pickup,
              ...Object.fromEntries(new FormData(f)),
            });
            await refresh();
          });
        }),
    );
  document.querySelectorAll("[data-action]").forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          const o = state.orders.find((o) => o.id === b.dataset.order),
            action = b.dataset.action;
          if (action === "label") {
            printLabel(o);
            return;
          }
          if (["pickup", "Delivered"].includes(action)) {
            proofOrder = o.id;
            proofStage = action;
            proofPickup = b.dataset.pickup;
            $("#proofForm").reset();
            $('#proofForm input[name="photo"]').required = !window.relayDemo;
            clear();
            const items =
              action === "pickup"
                ? o.items.filter(
                    (i) =>
                      i.vendor.id ===
                      o.pickups.find((p) => p.id === proofPickup).vendor.id,
                  )
                : o.items;
            $("#proofItems").innerHTML = items
              .map(
                (i) =>
                  `<label class="check"><input type="checkbox" name="verifiedItems" value="${i.id}" required> ${esc(i.name)} × ${i.quantity}</label>`,
              )
              .join("");
            $("#signatureArea").hidden = action !== "Delivered";
            $("#proof").showModal();
            await ProofDrafts.begin();
            return;
          }
          let extra = { item: b.dataset.item, pickup: b.dataset.pickup };
          if (action === "Out for delivery") {
            dispatchOrder = o;
            $("#dispatchItems").innerHTML = o.items
              .map(
                (i) =>
                  `<label class="check"><input type="checkbox" name="verifiedItems" value="${i.id}" required> ${esc(i.name)} × ${i.quantity} · ${esc(i.vendor.name)}</label>`,
              )
              .join("");
            $("#dispatch").showModal();
            return;
          }
          if (action === "fail" || action === "pickup-failed") {
            failureAction = action;
            failurePickup = b.dataset.pickup;
            failureOrder = o;
            $("#failureForm").reset();
            $("#failureForm h2").textContent =
              action === "pickup-failed"
                ? "Pickup unsuccessful"
                : "Delivery unsuccessful";
            $("#failure").showModal();
            return;
          }
          if (
            action === "return" &&
            !confirm(
              "Confirm that all items have physically returned to the warehouse?",
            )
          )
            return;
          await api("orders/" + o.id + "/action", { action, ...extra });
          await refresh();
          if (action === "start-pickup-trip" && state.user.role === "driver")
            startLocationSharing(true).catch((error) =>
              toast(error.message, "error"),
            );
        })),
  );
}
function printLabel(o) {
  showPrintLabels([o]);
}

let dispatchOrder,
  failureOrder,
  failureAction = "fail",
  failurePickup;
$("#dispatchForm").onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    await api("orders/" + dispatchOrder.id + "/action", {
      action: "Out for delivery",
      verifiedItems: new FormData(e.target).getAll("verifiedItems"),
    });
    $("#dispatch").close();
    await refresh();
    if (state.user.role === "driver")
      startLocationSharing(true).catch((error) =>
        toast(error.message, "error"),
      );
  });
};
$("#failureForm").onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    await api("orders/" + failureOrder.id + "/action", {
      action: failureAction,
      pickup: failurePickup,
      reason: new FormData(e.target).get("reason"),
    });
    $("#failure").close();
    await refresh();
  });
};
$("#printLabel").onclick = () => window.print();
document
  .querySelectorAll("[data-close]")
  .forEach((b) => (b.onclick = () => $("#" + b.dataset.close).close()));
const canvas = $("canvas"),
  ctx = canvas.getContext("2d");
let drawing = false;
function clear() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  signed = false;
}
$("#clear").onclick = () => {
  clear();
  ProofDrafts.autosave();
};
canvas.onpointerdown = (e) => {
  drawing = true;
  canvas.setPointerCapture(e.pointerId);
  ctx.beginPath();
  const r = canvas.getBoundingClientRect();
  ctx.moveTo(
    ((e.clientX - r.left) * canvas.width) / r.width,
    ((e.clientY - r.top) * canvas.height) / r.height,
  );
};
canvas.onpointermove = (e) => {
  if (!drawing) return;
  const r = canvas.getBoundingClientRect();
  ctx.lineTo(
    ((e.clientX - r.left) * canvas.width) / r.width,
    ((e.clientY - r.top) * canvas.height) / r.height,
  );
  ctx.stroke();
  signed = true;
};
canvas.onpointerup = () => {
  drawing = false;
  ProofDrafts.autosave();
};
canvas.onpointercancel = () => (drawing = false);
async function closeProofForm() {
  const draft = await ProofDrafts.save();
  if (
    draft?.volatile &&
    !confirm(
      "This proof could not be saved on the device. Closing may lose the draft. Close anyway?",
    )
  )
    return;
  $("#proof").close();
}
$("#cancel").onclick = () => run(closeProofForm);
$("#proof").addEventListener("cancel", (e) => {
  e.preventDefault();
  run(closeProofForm);
});
$("#proofForm").onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    let cleanupWarning = false;
    if (proofStage === "Delivered" && !signed)
      throw Error("Recipient signature required");
    if (window.relayDemo) {
      const f = new FormData(e.target),
        file = f.get("photo");
      const photo = file.size
        ? await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = reject;
            r.readAsDataURL(file);
          })
        : window.relayDemo.samplePhoto;
      await api("orders/" + proofOrder + "/action", {
        action: proofStage,
        pickup: proofPickup,
        name: f.get("name"),
        verifiedItems: f.getAll("verifiedItems"),
        photo,
        signature: proofStage === "Delivered" ? canvas.toDataURL() : undefined,
        lat: 29.3759,
        lng: 47.9774,
      });
    } else {
      // Persist before requesting GPS or a network upload.
      let draft = await ProofDrafts.save();
      if (!draft.body.photo) throw Error("Select a proof photo");
      if (!draft.body.capturedAt) {
        const pos = await new Promise((resolve, reject) =>
          navigator.geolocation
            ? navigator.geolocation.getCurrentPosition(
                resolve,
                () =>
                  reject(
                    Error(
                      "Allow GPS access. Your draft is saved on this device; retry at the handover location.",
                    ),
                  ),
                { enableHighAccuracy: true, timeout: 20000 },
              )
            : reject(Error("GPS is unavailable; draft retained")),
        );
        draft = await ProofDrafts.save(pos);
      }
      await api("orders/" + proofOrder + "/action", draft.body);
      try {
        await ProofDrafts.remove(draft.id);
      } catch {
        cleanupWarning = true;
      }
    }
    $("#proof").close();
    await refresh();
    if (cleanupWarning)
      toast(
        "Proof uploaded, but local draft cleanup failed. Verify the order and clear this device’s browser data.",
        "error",
      );
  });
};
$("#logout").onclick = () =>
  run(async () => {
    try {
      await stopLocationSharing();
    } catch {}
    const drafts = window.relayDemo
      ? []
      : (await ProofDrafts.all().catch(() => [])).filter(
          (r) => r.userId === state.user.id,
        );
    if (
      drafts.length &&
      !confirm(
        "You have pending on-device proof drafts. Signing out deletes them from this device. Sign out and delete drafts?",
      )
    )
      return;
    await api("logout", {});
    chatDrafts.clear();
    if (!window.relayDemo) {
      try {
        await ProofDrafts.clearUser(state.user.id);
      } catch {
        alert(
          "Signed out. Local draft cleanup failed; clear this device’s browser data before sharing it.",
        );
      }
    }
    if (window.relayDemo) location.assign("/");
    else location.reload();
  });
startOperationalPolling();
boot();

function renderAppearance(root) {
  const theme = window.MawadaTheme,
    current = theme.get();
  root.innerHTML = `<section class="appearanceSettings"><div class="eyebrow">YOUR WORKSPACE, YOUR STYLE</div><h2>Choose your atmosphere.</h2><p class="muted">Preview instantly. Saved for this browser on this device.</p><div class="themeGallery">${Object.entries(
    theme.palettes,
  )
    .map(
      ([key, p]) =>
        `<button class="themePreview" data-palette-choice="${key}" aria-pressed="${current.palette === key}" style="--preview-bg:${p.background};--preview-accent:${p.accent}"><div class="miniWorkspace"><i></i><span></span><span></span><span></span></div><strong>${p.name}</strong><small>${key === "midnight" ? "Black · burgundy · white" : key === "orchid" ? "Deep violet · luminous orchid" : "Classic Mawada plum"}</small></button>`,
    )
    .join(
      "",
    )}</div><form id="appearanceForm"><label>Appearance<select name="mode"><option value="system">Follow device</option><option value="light">Light</option><option value="dark">Dark</option></select></label><div class="colourChoices"><label>Accent colour<input type="color" name="accent" value="${current.custom.accent || theme.palettes[current.palette].accent}"></label><label>Background colour<input type="color" name="background" value="${current.custom.background || theme.palettes[current.palette].background}"></label></div><p class="muted">Use lighter lettering on dark backgrounds for readability. Custom colours override the selected palette.</p><label><input type="checkbox" name="motion" ${current.custom.motion !== false ? "checked" : ""}> Enable subtle animation (device reduced-motion preference is always respected)</label><div class="row"><button>Save custom colours</button><button type="button" class="ghost" id="resetColours">Reset custom colours</button></div><p id="appearanceSaved" role="status"></p></form></section>`;
  root.querySelector("[name=mode]").value = current.preference;
  root.querySelectorAll("[data-palette-choice]").forEach(
    (b) =>
      (b.onclick = () => {
        theme.set({
          palette: b.dataset.paletteChoice,
          custom: { motion: current.custom.motion },
          preference: "dark",
        });
        renderAppearance(root);
      }),
  );
  root.querySelector("#resetColours").onclick = () => {
    theme.set({ custom: {} });
    renderAppearance(root);
  };
  root.querySelector("#appearanceForm").onsubmit = (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    theme.set({
      preference: data.get("mode"),
      custom: {
        accent: data.get("accent"),
        background: data.get("background"),
        motion: data.has("motion"),
      },
    });
    root.querySelector("#appearanceSaved").textContent =
      "Appearance saved on this device.";
  };
  root.querySelector("[name=mode]").onchange = (e) =>
    theme.set({ preference: e.target.value });
}
