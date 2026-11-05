let chatSelection = null,
  chatFilterOrder = null,
  chatGeneration = 0,
  chatPolling = false;
const chatDrafts = new Map();
const chatKey = (t) => [state.user.id, t.orderId, t.driverId].join(":");
const canChat = () =>
  state?.user &&
  ["admin", "operations", "driver"].includes(state.user.role) &&
  MawadaAccess.allowed(state.user, "work");
function chatBadge(count) {
  document.querySelectorAll(".chatUnread").forEach((el) => {
    el.textContent = count ? String(count) : "";
    el.hidden = !count;
  });
}
function openDriverChat(orderId) {
  chatFilterOrder = orderId;
  chatSelection = null;
  view = "chat";
  render();
}
async function renderChat(root) {
  const generation = ++chatGeneration;
  root.innerHTML =
    '<section><h2>Driver chat</h2><p>Private, order-linked conversations between operations and each assigned driver. Messages refresh every 10 seconds while this app is open. For urgent issues, call; messages are not phone push notifications.</p></section><div class="chatWorkspace"><section class="chatInbox"><label>Find a conversation<input id="chatSearch" type="search" placeholder="AWB, reference or driver"></label><button id="chatShowAll" class="ghost">Show all orders</button><div id="chatThreads" aria-label="Driver conversations">Loading conversations…</div></section><section id="chatConversation"><p>Select a conversation.</p></section></div><p id="chatConnection" role="status"></p>';
  if (window.relayDemo) {
    root.innerHTML =
      "<section><h2>Driver chat</h2><p>Chat is available in the live workspace for assigned orders. The isolated demo does not send or store driver messages.</p></section>";
    return;
  }
  let inbox = [],
    rendered = [],
    latestSeen = 0,
    hasEarlier = false,
    sending = false,
    fetching = false;
  const current = () =>
    generation === chatGeneration && view === "chat" && root.isConnected;
  const status = (message) => {
    if (current()) root.querySelector("#chatConnection").textContent = message;
  };
  function threads() {
    const search = root.querySelector("#chatSearch").value.toLowerCase();
    const visible = inbox.filter(
      (t) =>
        (!chatFilterOrder || t.orderId === chatFilterOrder) &&
        [t.awb, t.reference, t.driverName]
          .join(" ")
          .toLowerCase()
          .includes(search),
    );
    root.querySelector("#chatThreads").innerHTML =
      visible
        .map(
          (t) =>
            `<button class="chatThread ${chatSelection && chatKey(t) === chatKey(chatSelection) ? "selected" : ""}" data-chat-thread="${esc(chatKey(t))}"><strong>${esc(t.awb)} · ${esc(t.driverName)}</strong><small>${esc(t.reference)} · ${esc(t.orderStatus)}</small><span>${esc(t.preview.slice(0, 100))}</span>${t.unread ? `<b>${t.unread} unread</b>` : ""}</button>`,
        )
        .join("") ||
      "<p>No assigned driver conversations match. Assign a driver to an order first.</p>";
    root
      .querySelectorAll("[data-chat-thread]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            select(inbox.find((t) => chatKey(t) === b.dataset.chatThread))),
      );
  }
  const path = (t) =>
    "chat/" +
    encodeURIComponent(t.orderId) +
    "/" +
    encodeURIComponent(t.driverId);
  function paintMessages(stick, prepend = false) {
    const list = root.querySelector("#chatMessages"),
      oldHeight = list.scrollHeight,
      oldTop = list.scrollTop;
    list.innerHTML =
      rendered
        .map(
          (m) =>
            `<article class="chatMessage ${m.senderId === state.user.id ? "mine" : ""}"><strong>${esc(m.senderName)} · ${m.senderRole === "driver" ? "Driver" : "Operations"}</strong><p>${esc(m.body)}</p><small>${esc(displayTime(m.at))}</small></article>`,
        )
        .join("") || "<p>No messages yet. Send the first update.</p>";
    if (stick) list.scrollTop = list.scrollHeight;
    else
      list.scrollTop =
        oldTop + (prepend ? Math.max(0, list.scrollHeight - oldHeight) : 0);
    root.querySelector("#chatEarlier").hidden = !hasEarlier;
  }
  async function acknowledge(t, through) {
    if (
      !current() ||
      document.hidden ||
      !chatSelection ||
      chatKey(t) !== chatKey(chatSelection)
    )
      return;
    await api(path(t) + "/read", { through });
    const thread = inbox.find((i) => chatKey(i) === chatKey(t));
    if (thread) thread.unread = 0;
    chatBadge(inbox.reduce((n, i) => n + i.unread, 0));
    threads();
  }
  async function load(t, earlier = false) {
    if (fetching) return;
    fetching = true;
    try {
      const suffix =
        earlier && rendered.length ? "?before=" + rendered[0].seq : "";
      const p = await api(path(t) + suffix);
      if (!current() || !chatSelection || chatKey(t) !== chatKey(chatSelection))
        return;
      const list = root.querySelector("#chatMessages"),
        atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
      if (earlier) {
        rendered = [...p.messages, ...rendered];
        hasEarlier = p.hasEarlier;
        paintMessages(false, true);
      } else {
        // After a long background pause, reopen the latest page without hiding a gap in history.
        if (
          rendered.length &&
          p.messages.length &&
          p.messages[0].seq > rendered.at(-1).seq + 1
        ) {
          rendered = [];
          hasEarlier = p.hasEarlier;
        }
        const merged = new Map(rendered.map((m) => [m.seq, m]));
        p.messages.forEach((m) => merged.set(m.seq, m));
        const changed = p.latest !== latestSeen || !rendered.length;
        if (!rendered.length) hasEarlier = p.hasEarlier;
        rendered = [...merged.values()].sort((a, b) => a.seq - b.seq);
        latestSeen = p.latest;
        if (changed) paintMessages(atBottom);
        root.querySelector("#chatJump").hidden = atBottom;
        if (atBottom) await acknowledge(t, latestSeen);
      }
      status("Messages updated " + displayTime(new Date().toISOString()));
    } catch (e) {
      if (current() && [401, 403, 404].includes(e.status)) {
        chatSelection = null;
        root.querySelector("#chatConversation").innerHTML =
          "<p>This conversation is no longer available. Check your access and the current assignment.</p>";
      }
      status(e.message + " Your unsent text stays here; retry when connected.");
    } finally {
      fetching = false;
    }
  }
  async function select(t) {
    if (!current() || sending) return;
    // A pending fetch for another conversation must finish before selecting.
    if (fetching) return;
    chatSelection = t;
    rendered = [];
    latestSeen = 0;
    hasEarlier = false;
    threads();
    root.querySelector("#chatConversation").innerHTML =
      `<h3>${esc(t.awb)} · ${state.user.role === "driver" ? "Operations" : esc(t.driverName)}</h3><p>Only operations and this driver can open this thread while assigned.</p><button id="chatEarlier" class="ghost" hidden>Load earlier messages</button><div id="chatMessages" class="chatMessages" role="log" aria-live="polite" aria-label="Conversation messages"></div><button id="chatJump" class="ghost" hidden>Jump to latest messages</button><form id="chatCompose"><label>Message<textarea name="body" maxlength="2000" rows="3" required placeholder="Write an update…"></textarea></label><button>Send message</button><p id="chatSendStatus" role="status"></p></form>`;
    const input = root.querySelector("#chatCompose textarea"),
      key = chatKey(t);
    input.value = chatDrafts.get(key)?.body || "";
    input.oninput = () =>
      chatDrafts.set(key, { body: input.value, clientId: crypto.randomUUID() });
    root.querySelector("#chatEarlier").onclick = () => load(t, true);
    root.querySelector("#chatJump").onclick = async () => {
      const list = root.querySelector("#chatMessages");
      list.scrollTop = list.scrollHeight;
      await load(t);
    };
    root.querySelector("#chatCompose").onsubmit = async (e) => {
      e.preventDefault();
      if (sending) return;
      const draft = chatDrafts.get(key) || {
        body: input.value,
        clientId: crypto.randomUUID(),
      };
      if (!draft.body.trim()) return;
      sending = true;
      input.disabled = true;
      const button = e.target.querySelector("button");
      button.disabled = true;
      chatDrafts.set(key, draft);
      try {
        await api(path(t) + "/messages", draft);
        chatDrafts.delete(key);
        if (
          !current() ||
          !chatSelection ||
          chatKey(t) !== chatKey(chatSelection)
        )
          return;
        input.value = "";
        root.querySelector("#chatSendStatus").textContent = "Message saved";
        await load(t);
      } catch (e) {
        if (!current()) return;
        root.querySelector("#chatSendStatus").textContent =
          e.message + " Text retained. Choose Send message to retry.";
      } finally {
        sending = false;
        input.disabled = false;
        button.disabled = false;
      }
    };
    await load(t);
  }
  async function refreshInbox() {
    const p = await api("chat/inbox");
    if (!current()) return;
    inbox = p.rows;
    chatBadge(p.unread);
    if (
      chatSelection &&
      !inbox.some((t) => chatKey(t) === chatKey(chatSelection))
    ) {
      chatSelection = null;
      root.querySelector("#chatConversation").innerHTML =
        "<p>This conversation is no longer available. Check the current driver assignment.</p>";
    }
    threads();
  }
  root.querySelector("#chatSearch").oninput = threads;
  root.querySelector("#chatShowAll").onclick = () => {
    chatFilterOrder = null;
    root.querySelector("#chatSearch").value = "";
    threads();
  };
  try {
    await refreshInbox();
    if (chatSelection)
      await select(inbox.find((t) => chatKey(t) === chatKey(chatSelection)));
    else if (chatFilterOrder) {
      const first = inbox.find((t) => t.orderId === chatFilterOrder);
      if (first) await select(first);
    }
  } catch (e) {
    status(e.message);
  }
  const timer = setInterval(async () => {
    if (!current()) {
      clearInterval(timer);
      return;
    }
    if (document.hidden || sending || fetching || chatPolling) return;
    chatPolling = true;
    try {
      await refreshInbox();
      if (chatSelection) await load(chatSelection);
    } catch (e) {
      status(e.message);
    } finally {
      chatPolling = false;
    }
  }, 10000);
}
setInterval(async () => {
  if (
    typeof state === "undefined" ||
    !canChat() ||
    window.relayDemo ||
    document.hidden ||
    view === "chat" ||
    chatPolling
  )
    return;
  chatPolling = true;
  try {
    chatBadge((await api("chat/inbox")).unread);
  } catch {
    /* Retry on next visible poll. */
  } finally {
    chatPolling = false;
  }
}, 10000);
