"use strict";

(() => {
  const icons = {
    logo: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.3l8 4.5"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    migrate: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
    userPlus: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M20 8v6m-3-3h6"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    settings: '<path d="m9 3-.7 2.4-2.2 1.3-2.4-.5-1.5 2.6 1.7 1.8v2.6L2.2 15l1.5 2.6 2.4-.5 2.2 1.3L9 21h3l.7-2.6 2.2-1.3 2.4.5 1.5-2.6-1.7-1.8v-2.6l1.7-1.8-1.5-2.6-2.4.5-2.2-1.3L12 3Z"/><circle cx="10.5" cy="12" r="3"/>',
    server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>',
    emby: '<path d="m12 3 9 9-9 9-9-9 9-9Z"/><path d="m10 8 6 4-6 4V8Z"/>',
    jellyfin: '<path d="M12 3 3.5 19h17L12 3Z"/><path d="m12 10-4 7h8l-4-7Z"/>',
    discord: '<path d="m6 5 3-1 .7 1.5h4.6L15 4l3 1c2.2 3.1 3.2 6.5 3 10-1.3 1.3-3 2.2-5 2.8L14.8 16M9.2 16 8 17.8c-2-.6-3.7-1.5-5-2.8-.2-3.5.8-6.9 3-10Z"/><path d="M7 15c3.2 1.7 6.8 1.7 10 0"/><ellipse cx="8.5" cy="11.5" rx="1" ry="1.4"/><ellipse cx="15.5" cy="11.5" rx="1" ry="1.4"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1.5L20 8M4 16l2.3 2.5A7 7 0 0 0 18 17"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    shield: '<path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    logout: '<path d="M10 4H5v16h5M14 8l4 4-4 4m-5-4h9"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    key: '<circle cx="8" cy="8" r="5"/><path d="m11.5 11.5 9 9M16 16l3-3M19 19l3-3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    inbox: '<path d="M4 4h16l2 12v4H2v-4L4 4Z"/><path d="M2 16h6l2 2h4l2-2h6"/>',
    link: '<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/>',
  };
  const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.info}</svg>`;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const app = document.querySelector("#app");
  const modalRoot = document.querySelector("#modal-root");
  const state = { session: null, page: "overview", overview: null, users: {emby: [], jellyfin: []}, settings: null, jobs: [], events: [], selected: new Set(), search: "", preview: null, modalJob: null, modalKind: null, poll: null, pollBusy: false, pageRequest: 0 };
  const pages = {
    overview: { title: "Overview", icon: "grid" },
    migrate: { title: "Migrate users", icon: "migrate" },
    accounts: { title: "Create account", icon: "userPlus" },
    subscriptions: { title: "Subscriptions", icon: "inbox" },
    activity: { title: "Activity", icon: "activity" },
    settings: { title: "Settings", icon: "settings" },
  };
  const activeJob = job => ["queued", "running"].includes(job.status);
  const num = value => Number(value || 0).toLocaleString();
  const initials = name => String(name || "?").slice(0, 2).toUpperCase();
  const date = value => {
    if (!value) return "—";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
  };
  const safeUrl = value => {
    try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) ? u.href : ""; } catch { return ""; }
  };

  async function api(path, options = {}) {
    const headers = {"Accept": "application/json", ...(options.headers || {})};
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.method && options.method !== "GET" && state.session?.csrf_token) headers["X-CSRF-Token"] = state.session.csrf_token;
    let response;
    try { response = await fetch(path, {...options, headers, credentials: "same-origin", body: options.body === undefined ? undefined : JSON.stringify(options.body)}); }
    catch { throw new Error("Could not reach Jellyport. Check that the application is running and try again."); }
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      if (response.status === 401 && path !== "/api/login") { state.session = null; stopPolling(); closeModal(); renderLogin(); }
      let detail = data.detail || data.error || data.message;
      if (Array.isArray(detail)) detail = detail.map(item => item.msg || "Invalid input").join("; ");
      if (detail && typeof detail === "object") detail = detail.message || JSON.stringify(detail);
      throw new Error(detail || `Request failed (${response.status}).`);
    }
    return data;
  }

  function toast(message, error = false) {
    const node = document.createElement("div");
    node.className = `toast${error ? " error" : ""}`;
    node.innerHTML = `${svg(error ? "warning" : "check")}<span>${esc(message)}</span>`;
    document.querySelector("#toast-region").append(node);
    window.setTimeout(() => node.remove(), error ? 9000 : 5000);
  }

  async function busy(button, work, label = "Working…") {
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>${esc(label)}`;
    try { return await work(); }
    catch (error) { toast(error.message, true); return null; }
    finally { if (button.isConnected) { button.innerHTML = original; button.disabled = false; } }
  }

  function loading() { return '<div class="loading"><span class="spinner"></span>Loading…</div>'; }
  function empty(icon, title, text, action = "") { return `<div class="empty"><div class="empty-icon">${svg(icon)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`; }
  function navButton(page, title = pages[page].title, className = "btn") { return `<button class="${className}" data-nav="${page}">${esc(title)}</button>`; }
  function status(value, override) {
    const labels = { completed: "Completed", partial: "Needs review", failed: "Failed", processing: "Processing", running: "In progress", queued: "Queued", interrupted: "Interrupted", pending: "Awaiting review", applied: "Applied", ignored: "Ignored", success: "Completed", migrated: "Migrated", created: "Created" };
    const good = ["completed", "applied", "success", "migrated", "created"].includes(value);
    const bad = ["failed", "interrupted"].includes(value);
    const running = ["running", "queued", "processing"].includes(value);
    return `<span class="status ${good ? "good" : bad ? "bad" : running ? "running" : "warn"}">${esc(override || labels[value] || value || "Unknown")}</span>`;
  }
  function userCell(name) { return `<div class="user-cell"><span class="avatar" aria-hidden="true">${esc(initials(name))}</span><strong>${esc(name)}</strong></div>`; }
  function pageHeading(title, description, actions = "", eyebrow = "") { return `<div class="page-heading"><div>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ""}<h1>${esc(title)}</h1><p>${esc(description)}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ""}</div>`; }

  function renderLogin(error = "") {
    app.innerHTML = `<main class="login-screen"><div class="login-card"><div class="brand"><span class="brand-icon">${svg("logo")}</span><div>Jellyport<small>YOUR NEXT CHAPTER</small></div></div><h1>Welcome back</h1><p>Sign in to manage accounts and bring your users over to Jellyfin.</p><form id="login-form" class="form-stack">${error ? `<div class="error-block" role="alert">${esc(error)}</div>` : ""}<div class="field"><label for="admin-password">Admin password</label><input id="admin-password" name="password" type="password" autocomplete="current-password" placeholder="Enter your admin password" required autofocus></div><button class="btn btn-primary" type="submit">${svg("lock")}Sign in</button></form><div class="login-footer">Use the admin password configured for this Jellyport instance.<br>Emby → Jellyfin, with everyone’s progress intact.</div></div></main>`;
    document.querySelector("#login-form").addEventListener("submit", async event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector("button");
      const password = event.currentTarget.elements.password.value;
      await busy(button, async () => {
        state.session = await api("/api/login", {method: "POST", body: {password}});
        if (!state.session.authenticated) throw new Error("Sign-in was not successful. Check your admin password.");
        renderShell();
        await navigate(state.page);
      }, "Signing in…");
    });
  }

  function renderShell() {
    app.innerHTML = `<div class="shell"><aside class="sidebar" aria-label="Main navigation"><div class="brand"><span class="brand-icon">${svg("logo")}</span><div>Jellyport<small>EMBY → JELLYFIN</small></div></div><div class="nav-label">Workspace</div><nav class="nav">${Object.entries(pages).map(([key, page]) => `<button class="nav-button${state.page === key ? " active" : ""}" data-nav="${key}"${state.page === key ? ' aria-current="page"' : ""}>${svg(page.icon)}${esc(page.title)}${state.page === key ? '<span class="nav-dot"></span>' : ""}</button>`).join("")}</nav><div class="sidebar-bottom"><div class="operator-card"><div class="avatar">AD</div><div><strong>Administrator</strong><span>Local workspace</span></div><button class="icon-button" id="logout" aria-label="Sign out" title="Sign out">${svg("logout")}</button></div><div class="sidebar-note">A smoother way to move forward.</div></div></aside><main class="main"><header class="topbar"><button class="icon-button mobile-menu" id="mobile-menu" aria-label="Toggle navigation" aria-expanded="false">${svg("menu")}</button><div class="breadcrumb"><span>Workspace</span><span>/</span><span id="breadcrumb-page">${esc(pages[state.page].title)}</span></div><div class="topbar-right"><span class="version-label">Emby → Jellyfin</span><span class="operator-label">ADMIN CONSOLE</span></div></header><div class="content" id="content"></div></main></div>`;
    document.querySelector("#logout").addEventListener("click", async event => {
      await busy(event.currentTarget, async () => {
        await api("/api/logout", {method: "POST", body: {}});
        state.session = null;
        state.preview = null;
        state.selected.clear();
        closeModal();
        stopPolling();
        renderLogin();
      }, "");
    });
    document.querySelector("#mobile-menu").addEventListener("click", event => {
      const open = document.querySelector(".sidebar").classList.toggle("mobile-open");
      event.currentTarget.setAttribute("aria-expanded", String(open));
    });
  }

  function content() { return document.querySelector("#content"); }
  function demoBanner() { return state.session?.demo ? `<div class="demo-banner">${svg("info")}Demo mode is active. Accounts, watch history, and Discord messages use sample data. Settings are read-only.</div>` : ""; }
  async function navigate(page) {
    if (!pages[page] || !state.session?.authenticated) return;
    closeModal();
    state.page = page;
    const request = ++state.pageRequest;
    document.querySelectorAll(".nav-button").forEach(button => {
      const current = button.dataset.nav === page;
      button.classList.toggle("active", current);
      if (current) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
      button.querySelector(".nav-dot")?.remove();
      if (current) button.insertAdjacentHTML("beforeend", '<span class="nav-dot"></span>');
    });
    document.querySelector("#breadcrumb-page").textContent = pages[page].title;
    document.querySelector(".sidebar").classList.remove("mobile-open");
    document.querySelector("#mobile-menu").setAttribute("aria-expanded", "false");
    content().innerHTML = demoBanner() + loading();
    try {
      if (page === "overview") state.overview = await api("/api/overview");
      if (page === "migrate") { state.users = await api("/api/users"); state.overview = await api("/api/overview"); }
      if (page === "accounts") { state.settings = await api("/api/settings"); state.overview = await api("/api/overview"); }
      if (page === "activity") state.jobs = (await api("/api/jobs")).jobs || [];
      if (page === "subscriptions") state.events = (await api("/api/subscriptions")).events || [];
      if (page === "settings") { state.settings = await api("/api/settings"); try { state.users = await api("/api/users"); } catch (error) { state.users = {emby: [], jellyfin: []}; if (state.session?.authenticated) toast(`Template users could not be loaded: ${error.message}`, true); } }
      if (request !== state.pageRequest || !state.session?.authenticated) return;
      renderPage();
      updatePolling();
    } catch (error) {
      if (request === state.pageRequest && state.session?.authenticated) content().innerHTML = demoBanner() + pageHeading(pages[page].title, "Your workspace could not be loaded.") + `<div class="error-block" role="alert">${esc(error.message)}</div><div class="mt-18"><button class="btn" id="retry-page">${svg("refresh")}Try again</button></div>`;
      document.querySelector("#retry-page")?.addEventListener("click", () => navigate(page));
    }
  }
  function renderPage() {
    const renderers = {overview: renderOverview, migrate: renderMigrate, accounts: renderAccounts, activity: renderActivity, subscriptions: renderSubscriptions, settings: renderSettings};
    content().innerHTML = demoBanner() + renderers[state.page]();
    bindPage();
  }

  function connectionRow(kind, label) {
    const conn = state.overview?.connections?.[kind] || {};
    const configured = kind === "discord" ? conn.enabled : conn.configured;
    const detail = conn.connected ? [conn.name || (kind === "discord" ? "Bot online" : "Server connected"), conn.version].filter(Boolean).join(" · ") : conn.error || (configured ? "Connection needs attention" : kind === "discord" ? "Optional account delivery" : "Add server details in Settings");
    return `<div class="server-row"><span class="server-icon ${kind}">${svg(kind)}</span><div class="server-name"><strong>${label}</strong><small title="${esc(detail)}">${esc(detail)}</small></div><span class="status ${conn.connected ? "good" : configured ? "warn" : ""}">${conn.connected ? "Connected" : configured ? "Offline" : kind === "discord" ? "Optional" : "Not set up"}</span></div>`;
  }
  function jobsTable(jobs, compact = false) {
    if (!jobs.length) return empty("activity", "A fresh start", "Your migration and account creation activity will appear here.", navButton("migrate", "Migrate your first user", "btn btn-quiet"));
    return `<div class="table-wrap"><table><thead><tr><th>Operation</th><th>Status</th>${!compact ? "<th>Users</th>" : ""}<th>Started</th><th class="right">Details</th></tr></thead><tbody>${jobs.map(job => `<tr><td><strong>${esc(({migrate: "User migration", migration: "User migration", create: "Account creation", account: "Account creation", recover: "Account recovery", disable: "Disable account", enable: "Enable account"}[job.kind] || job.kind || "Account operation"))}</strong><small>${esc((job.results || []).map(result => result.username).filter(Boolean).slice(0, 2).join(", ") || "Preparing operation")}${(job.results || []).length > 2 ? ` +${job.results.length - 2}` : ""}</small></td><td>${status(job.status)}</td>${!compact ? `<td>${num((job.results || []).length)}</td>` : ""}<td class="nowrap">${esc(date(job.created_at))}</td><td class="right"><button class="icon-button" data-job="${esc(job.id)}" aria-label="View operation details" title="View details">${svg("arrow")}</button></td></tr>`).join("")}</tbody></table></div>`;
  }
  function renderOverview() {
    const data = state.overview || {};
    const counts = data.counts || {};
    const ready = data.connections?.emby?.connected && data.connections?.jellyfin?.connected;
    return pageHeading("Everyone’s next chapter.", "Bring your users, their progress, and your community over to Jellyfin.", `<button class="btn btn-quiet" id="refresh-overview">${svg("refresh")}Refresh</button><button class="btn btn-primary" data-nav="migrate">${svg("migrate")}Migrate users</button>`, "YOUR MIGRATION WORKSPACE") + (!data.connections?.jellyfin?.configured ? `<div class="callout">${svg("info")}<div><strong>Start by connecting your servers.</strong><p>Add your Emby and Jellyfin API keys, then choose the Jellyfin user whose permissions new accounts should inherit. ${navButton("settings", "Open settings", "text-button")}</p></div></div>` : "") + `<div class="metrics"><div class="metric"><div class="metric-top">Emby users<span class="metric-icon mint">${svg("users")}</span></div><div class="metric-number">${num(counts.emby_users)}</div><div class="metric-note">Ready for their next chapter</div></div><div class="metric"><div class="metric-top">Jellyfin users<span class="metric-icon">${svg("jellyfin")}</span></div><div class="metric-number">${num(counts.jellyfin_users)}</div><div class="metric-note">Accounts on your destination server</div></div><div class="metric"><div class="metric-top">Operations<span class="metric-icon blue">${svg("activity")}</span></div><div class="metric-number">${num(counts.jobs)}</div><div class="metric-note">Migrations and account changes</div></div></div><div class="dashboard-grid"><div class="stack"><section class="panel"><div class="panel-header"><div><h2>Server connections</h2><p>Your migration route, at a glance.</p></div>${navButton("settings", "Manage", "btn btn-small btn-quiet")}</div><div class="server-list">${connectionRow("emby", "Emby")}${connectionRow("jellyfin", "Jellyfin")}${connectionRow("discord", "Discord")}</div></section><section class="panel"><div class="panel-header"><div><h2>Recent activity</h2><p>A record of every move.</p></div>${navButton("activity", "View all", "text-button")}</div>${jobsTable(data.recent_jobs || [], true)}</section></div><div class="stack"><section class="panel"><div class="panel-header"><h2>Make the next move</h2></div><div class="quick-actions"><button class="quick-action" data-nav="migrate">${svg("migrate")}<span><strong>Migrate existing users</strong><small>Keep usernames and played status.</small></span>${svg("chevron")}</button><button class="quick-action" data-nav="accounts">${svg("userPlus")}<span><strong>Create a fresh account</strong><small>A warm welcome for a new member.</small></span>${svg("chevron")}</button><button class="quick-action" data-nav="subscriptions">${svg("inbox")}<span><strong>Review subscriptions</strong><small>Approve incoming membership events.</small></span>${svg("chevron")}</button></div></section><section class="panel"><div class="panel-body"><h3>Your users. Their progress.</h3><p class="muted text-small mt-9">Preview the match before you migrate. Existing Jellyfin played status is preserved as Emby history is added.</p><div class="flow"><div class="flow-node"><span class="server-icon emby">${svg("emby")}</span>Emby</div><span class="flow-line"></span><div class="flow-node"><span class="server-icon jellyfin">${svg("jellyfin")}</span>Jellyfin</div><span class="flow-line"></span><div class="flow-node"><span class="server-icon discord">${svg("discord")}</span>Discord</div></div><div class="status ${ready ? "good" : ""}">${ready ? "Servers are ready" : "Configure servers to begin"}</div></div></section></div></div><div class="footer-note">${svg("shield")}Self-hosted. Your servers, your community.</div>`;
  }

  function userWarnings() {
    return Object.entries(state.users.errors || {}).map(([server, message]) => `<div class="callout warning">${svg("warning")}<div><strong>${esc(server === "jellyfin" ? "Jellyfin" : "Emby")} users could not be loaded.</strong><p>${esc(message)} Check the saved connection and try again.</p></div></div>`).join("");
  }
  function renderMigrate() {
    const connected = state.overview?.connections?.emby?.connected && state.overview?.connections?.jellyfin?.connected;
    return pageHeading("Migrate users", "Same usernames. A new home. Bring Emby played status into Jellyfin.", `<button class="btn btn-primary" id="preview-migration" ${!state.selected.size ? "disabled" : ""}>${svg("migrate")}Preview migration${state.selected.size ? ` (${state.selected.size})` : ""}</button>`) + '<div class="steps"><span class="step active"><span class="step-number">1</span>Select users</span><span class="step-separator"></span><span class="step"><span class="step-number">2</span>Preview matches</span><span class="step-separator"></span><span class="step"><span class="step-number">3</span>Migrate & deliver</span></div>' + userWarnings() + (!connected ? `<div class="callout warning">${svg("warning")}<div><strong>Both servers need to be connected.</strong><p>${navButton("settings", "Check your server settings", "text-button")} before starting a migration.</p></div></div>` : "") + `<div class="migration-layout"><section class="panel"><div class="panel-header"><div><h2>Emby users</h2><p>Select up to 100 users for one migration.</p></div><span class="status">${num(state.users.emby?.length)} users</span></div><div class="toolbar"><div class="search-wrap">${svg("search")}<input type="search" id="user-search" aria-label="Search Emby users" placeholder="Search by username…" value="${esc(state.search)}"></div><span class="selection-info" id="selection-info">${num(state.selected.size)} selected</span></div><div id="user-table">${userTable()}</div><div class="table-footer"><span id="filtered-info"></span><button class="text-button" id="clear-selection" ${!state.selected.size ? "disabled" : ""}>Clear selection</button></div></section><aside class="panel aside-panel"><div class="panel-body"><span class="server-icon jellyfin mb-17">${svg("shield")}</span><h3>What comes along</h3><ul><li>The same username</li><li>Played status for matched movies and episodes</li><li>Permissions from your template user for new accounts</li><li>A generated password for each new account</li></ul></div><div class="aside-footer">Existing accounts keep their passwords. Unmatched items are reported for review.</div></aside></div>`;
  }
  function filteredUsers() { const query = state.search.trim().toLowerCase(); return (state.users.emby || []).filter(user => user.Name.toLowerCase().includes(query)); }
  function userTable() {
    const users = filteredUsers();
    const targetNames = new Set((state.users.jellyfin || []).map(user => user.Name.toLowerCase()));
    if (!users.length) return empty("users", state.search ? "No matching users" : "No Emby users yet", state.search ? "Try another username." : "Connect your Emby server in Settings to load its users.", state.search ? "" : navButton("settings", "Connect Emby", "btn btn-quiet"));
    return `<div class="table-wrap"><table><thead><tr><th class="check-col"><input class="checkbox" id="select-all" type="checkbox" aria-label="Select all visible Emby users"></th><th>Username</th><th>Jellyfin account</th><th class="right">Emby access</th></tr></thead><tbody>${users.map(user => `<tr><td class="check-col"><input type="checkbox" class="checkbox user-check" value="${esc(user.Id)}" aria-label="Select ${esc(user.Name)}" ${state.selected.has(user.Id) ? "checked" : ""}></td><td>${userCell(user.Name)}</td><td>${targetNames.has(user.Name.toLowerCase()) ? '<span class="status">Already exists</span>' : '<span class="status good">Will be created</span>'}</td><td class="right"><span class="subtle">${user.Policy?.IsDisabled ? "Disabled" : user.Policy?.IsAdministrator ? "Administrator" : "User"}</span></td></tr>`).join("")}</tbody></table></div>`;
  }
  function updateSelection() {
    document.querySelector("#selection-info").textContent = `${num(state.selected.size)} selected`;
    const preview = document.querySelector("#preview-migration");
    preview.disabled = !state.selected.size;
    preview.innerHTML = `${svg("migrate")}Preview migration${state.selected.size ? ` (${state.selected.size})` : ""}`;
    document.querySelector("#clear-selection").disabled = !state.selected.size;
    document.querySelector("#filtered-info").textContent = `${num(filteredUsers().length)} of ${num(state.users.emby?.length)} users`;
    const all = document.querySelector("#select-all");
    if (all) { const selected = filteredUsers().filter(user => state.selected.has(user.Id)).length; all.checked = selected === filteredUsers().length; all.indeterminate = selected > 0 && !all.checked; }
  }
  async function previewMigration(button) {
    if (state.selected.size > 100) { toast("Select up to 100 users for one migration.", true); return; }
    await busy(button, async () => {
      state.preview = await api("/api/migrations/preview", {method: "POST", body: {source_user_ids: [...state.selected]}});
      if (!state.preview.users?.length) throw new Error("No users were returned for this preview. Reload the Emby user list and try again.");
      showPreview();
    }, "Matching history…");
  }
  function showPreview() {
    const preview = state.preview;
    const users = preview.users || [];
    showModal("Review your migration", `${users.length} ${users.length === 1 ? "user" : "users"} selected · played status will be merged`, `<div class="callout">${svg("shield")}<div><strong>Preview before you move.</strong><p>Matched items marked played in Emby will be marked played in Jellyfin. Existing played status stays intact. Unmatched and ambiguous items are skipped.</p></div></div>${users.map(user => { const s = user.stats || {}; return `<section class="preview-user"><div class="preview-user-header">${userCell(user.username)}<span class="status ${user.target_exists ? "" : "good"}">${user.target_exists ? "Merge into existing account" : "Create new account"}</span></div><div class="preview-stats"><div class="preview-stat"><strong>${num(s.source_played)}</strong><span>Played in Emby</span></div><div class="preview-stat"><strong class="mint">${num(s.matched)}</strong><span>Matched to Jellyfin</span></div><div class="preview-stat"><strong class="${s.unmatched ? "" : "muted"}">${num(s.unmatched)}</strong><span>Unmatched</span></div><div class="preview-stat"><strong class="${s.ambiguous ? "" : "muted"}">${num(s.ambiguous)}</strong><span>Ambiguous</span></div></div><div class="preview-user-body">${s.already_played ? `<p class="subtle text-tiny mb-14">${num(s.already_played)} matched items are already played on Jellyfin.</p>` : ""}${previewIssues("Unmatched items", user.unmatched, s.unmatched)}${previewIssues("Ambiguous items", user.ambiguous, s.ambiguous)}${user.target_exists ? '<p class="subtle text-tiny mb-14">The existing Jellyfin password and account permissions will be preserved.</p>' : ""}<div class="field"><label for="recipient-${esc(user.source_user_id)}">Discord recipient <span class="optional">optional</span></label><input id="recipient-${esc(user.source_user_id)}" data-recipient="${esc(user.source_user_id)}" placeholder="Discord user ID, e.g. 123456789012345678" inputmode="numeric" autocomplete="off"><small>${user.target_exists ? "Link this member for membership management. Their existing password is preserved." : "Send the new username and password in a private message."} For a new Discord link, this username must match the member’s Discord username.</small></div></div></section>`; }).join("")}`, `<button class="btn btn-quiet" data-close-modal>Back to users</button><button class="btn btn-primary" id="execute-migration">${svg("migrate")}Start migration</button>`, "modal-wide");
    document.querySelector("#execute-migration").addEventListener("click", async event => {
      const recipients = {};
      let invalid = false;
      document.querySelectorAll("[data-recipient]").forEach(input => {
        const value = input.value.trim();
        if (value && !/^\d{15,22}$/.test(value)) { input.setCustomValidity("Enter a valid Discord user ID (15–22 digits)."); input.reportValidity(); invalid = true; }
        else { input.setCustomValidity(""); if (value) recipients[input.dataset.recipient] = value; }
      });
      if (invalid) return;
      await busy(event.currentTarget, async () => {
        const job = await api("/api/migrations", {method: "POST", body: {source_user_ids: users.map(user => user.source_user_id), discord_recipients: recipients}});
        state.jobs = [job, ...state.jobs.filter(existing => existing.id !== job.id)];
        state.selected.clear();
        state.preview = null;
        closeModal();
        if (state.page === "migrate") { document.querySelector("#user-table").innerHTML = userTable(); updateSelection(); }
        showJob(job);
        updatePolling();
        toast("Migration started. You can follow its progress here.");
      }, "Starting migration…");
    });
  }
  function previewIssues(label, items, count) {
    if (!count && !items?.length) return "";
    return `<details class="disclosure"><summary>${esc(label)} (${num(count || items.length)})</summary>${items?.length ? `<ul>${items.map(item => `<li>${esc(item.Name || item.name || item.title || item.source?.Name || "Unnamed item")}${item.Type ? ` <span class="subtle">· ${esc(item.Type)}</span>` : ""}</li>`).join("")}</ul>` : '<p class="mt-8">See the operation details after migration for more information.</p>'}</details>`;
  }

  function renderAccounts() {
    const ready = state.overview?.connections?.jellyfin?.connected && state.settings?.template_user_id;
    const discordReady = state.overview?.connections?.discord?.connected;
    return pageHeading("Welcome someone new.", "Create a Jellyfin account with your template’s permissions and a secure generated password.") + (!ready ? `<div class="callout warning">${svg("warning")}<div><strong>Finish your Jellyfin setup first.</strong><p>Connect Jellyfin and choose your template user in ${navButton("settings", "Settings", "text-button")}.</p></div></div>` : "") + `<div class="section-grid"><section class="panel"><div class="panel-header"><div><h2>Create a fresh account</h2><p>For new members without an Emby account.</p></div><span class="server-icon jellyfin">${svg("userPlus")}</span></div><div class="panel-body"><form id="create-account-form" class="form-stack"><div class="field"><label for="account-username">Username</label><input id="account-username" name="username" placeholder="Enter a username" required maxlength="64" autocomplete="off"><small>When a Discord recipient is supplied, use their Discord username, rather than a server nickname.</small></div><div class="field"><label for="account-discord">Discord user ID <span class="optional">optional</span></label><input id="account-discord" name="discord_user_id" inputmode="numeric" pattern="[0-9]{15,22}" placeholder="e.g. 123456789012345678" autocomplete="off"><small>${discordReady ? "Jellyport will privately message this member with their credentials." : "Connect your Discord bot in Settings to enable private account delivery."}</small></div><div class="callout mb-0">${svg("key")}<div><strong>A password will be generated automatically.</strong><p>You can reveal it once after the account is created. If delivery fails, the operation will show the reason.</p></div></div><div class="form-actions"><button type="submit" class="btn btn-primary" ${!ready ? "disabled" : ""}>${svg("userPlus")}Create account</button></div></form></div></section><aside class="stack"><section class="panel"><div class="panel-header"><h2>Ready from day one</h2></div><div class="panel-body"><div class="command-row">${svg("shield")}<strong class="command-title">Your template permissions</strong><p>New accounts inherit library access and account permissions from your selected Jellyfin template.</p></div><div class="command-row">${svg("discord")}<strong class="command-title">A stable Discord link</strong><p>Discord user IDs keep each membership linked to its Jellyfin account. The initial username is preserved even if their Discord name changes.</p></div><div class="command-row">${svg("lock")}<strong class="command-title">Private credential delivery</strong><p>Credentials are sent by direct message. Members should change their password after signing in.</p></div></div></section><div class="callout">${svg("migrate")}<div><strong>Already using Emby?</strong><p>Use ${navButton("migrate", "Migrate users", "text-button")} to keep their username and played history.</p></div></div></aside></div>` + recoveryPanel();
  }
  function recoveryPanel() {
    return `<details class="panel recovery-panel"><summary>${svg("refresh")}Recover an interrupted account creation</summary><p class="muted text-small">If a creation request timed out after reaching Jellyfin, inspect the resulting account before retrying. Recovery is available only for an incomplete creation tracked by Jellyport.</p><form id="recovery-form"><div class="field-row"><div class="field"><label for="recovery-username">Account to inspect</label><input id="recovery-username" name="username" required maxlength="64" placeholder="Exact Jellyfin username" autocomplete="off"></div><div class="field"><label for="recovery-discord">Discord user ID <span class="optional">optional</span></label><input id="recovery-discord" name="discord_user_id" inputmode="numeric" pattern="[0-9]{15,22}" placeholder="Credential recipient" autocomplete="off"></div></div><div class="form-actions"><button class="btn btn-quiet" type="submit">${svg("search")}Inspect account</button></div></form><div class="recovery-result" id="recovery-result" aria-live="polite"></div></details>`;
  }
  async function inspectRecovery(form, button) {
    await busy(button, async () => {
      const username = form.elements.username.value.trim();
      const discordId = form.elements.discord_user_id.value.trim();
      const result = await api(`/api/accounts/recovery?username=${encodeURIComponent(username)}`);
      const container = document.querySelector("#recovery-result");
      container.innerHTML = `<div class="callout ${result.eligible ? "warning" : ""}">${svg(result.eligible ? "warning" : "info")}<div><strong>${esc(result.username)} · ${result.eligible ? "Eligible for recovery" : "Recovery unavailable"}</strong><p>${esc(result.reason)}</p>${result.target_user_id ? `<span class="recovery-target mono">Jellyfin account ID: ${esc(result.target_user_id)}</span>` : ""}</div></div>${result.eligible ? '<label class="approval-check"><input type="checkbox" class="checkbox" id="approve-recovery"><span>I inspected this Jellyfin account and approve a new password and template permissions.</span></label><div class="form-actions"><button class="btn btn-danger" type="button" id="recover-account" disabled>Recover account</button></div>' : ""}`;
      const recover = container.querySelector("#recover-account");
      container.querySelector("#approve-recovery")?.addEventListener("change", event => { recover.disabled = !event.currentTarget.checked; });
      recover?.addEventListener("click", async event => {
        await busy(event.currentTarget, async () => {
          const job = await api("/api/accounts/recover", {method: "POST", body: {username: result.username, target_user_id: result.target_user_id, discord_user_id: discordId || undefined}});
          state.jobs = [job, ...state.jobs.filter(existing => existing.id !== job.id)];
          container.replaceChildren();
          form.reset();
          showJob(job);
          updatePolling();
          toast("Account recovery started.");
        }, "Recovering…");
      });
    }, "Inspecting…");
  }
  function renderActivity() {
    const active = state.jobs.filter(activeJob).length;
    return pageHeading("Every move, recorded.", "Review migrations, new accounts, and any items that need your attention.", `<button class="btn btn-quiet" id="refresh-activity">${svg("refresh")}Refresh</button>`) + `<section class="panel"><div class="panel-header"><div><h2>Operation history</h2><p>${active ? `${num(active)} ${active === 1 ? "operation is" : "operations are"} running. Progress updates automatically.` : "Open an operation to see its results and account delivery."}</p></div><span class="status">${num(state.jobs.length)} operations</span></div>${jobsTable(state.jobs)}<div class="table-footer"><span>Newest first</span><span>Credentials are available through an explicit, one-time reveal.</span></div></section>`;
  }
  function renderSubscriptions() {
    const pending = state.events.filter(event => event.status === "pending").length;
    return pageHeading("Membership, connected.", "Review trusted Discord membership events before making account changes.", `<button class="btn btn-quiet" id="refresh-subscriptions">${svg("refresh")}Refresh</button>${navButton("settings", "Automation settings", "btn")}`) + `<div class="callout">${svg("shield")}<div><strong>You stay in control.</strong><p>Automatic creation and disabling are off by default. A subscription cancellation and an access expiration can be handled separately in Settings.</p></div></div><section class="panel"><div class="panel-header"><div><h2>Subscription events</h2><p>${pending ? `${num(pending)} ${pending === 1 ? "event is" : "events are"} waiting for review.` : "Events appear when your configured Discord integration receives a membership change."}</p></div><span class="status ${pending ? "warn" : ""}">${num(pending)} pending</span></div>${state.events.length ? `<div class="table-wrap"><table><thead><tr><th>Member</th><th>Event</th><th>Status</th><th>Received</th><th class="right">Action</th></tr></thead><tbody>${state.events.map(event => `<tr><td><strong>${esc(event.username || "Discord member")}</strong><small>${esc(event.discord_user_id || "")}</small>${event.error ? `<small class="red">${esc(event.error)}</small>` : ""}</td><td><span>${esc({subscribe: "Subscribed", cancel: "Cancellation", expire: "Access expired"}[event.action] || event.action)}</span><small>${esc(event.source || "Discord")}</small></td><td>${status(event.status)}</td><td class="nowrap">${esc(date(event.created_at))}</td><td class="right nowrap">${["pending", "failed"].includes(event.status) ? `<button class="btn btn-small btn-quiet" data-ignore-event="${esc(event.id)}">Ignore</button> <button class="btn btn-small btn-primary" data-apply-event="${esc(event.id)}">Review</button>` : event.job_id ? `<button class="btn btn-small btn-quiet" data-job="${esc(event.job_id)}">View operation</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : empty("inbox", "Your review queue is clear", "Connect the Discord bot and configure trusted membership events in Settings to start collecting subscription activity.", navButton("settings", "Configure Discord", "btn btn-quiet"))}</section>`;
  }
  function reviewEvent(id) {
    const event = state.events.find(item => item.id === id);
    if (!event) return;
    const action = {subscribe: "Process subscription", cancel: "Process cancellation", expire: "Process expiration"}[event.action] || "Process event";
    showModal(action, `${event.username || "Discord member"} · ${event.discord_user_id || "No Discord ID"}`, `<div class="callout ${event.action === "subscribe" ? "" : "warning"}">${svg(event.action === "subscribe" ? "userPlus" : "warning")}<div><strong>${event.action === "subscribe" ? "Create or link this member’s Jellyfin account." : "Disable the linked Jellyfin account now."}</strong><p>${event.action === "subscribe" ? "Jellyport uses the Discord username for a new account, then preserves its linked username for future membership events." : "Approving this event manually disables access immediately, even when automatic disabling is off. The account, password, and watch history are preserved."}</p></div></div><p class="muted text-small">This event was received ${esc(date(event.created_at))} from ${esc(event.source || "Discord")}. Review your membership settings before applying it.</p>`, `<button class="btn btn-quiet" data-close-modal>Cancel</button><button class="btn btn-primary" id="confirm-event">${svg("check")}${event.action === "subscribe" ? "Apply subscription" : "Disable account now"}</button>`);
    document.querySelector("#confirm-event").addEventListener("click", async click => {
      await busy(click.currentTarget, async () => {
        const result = await api(`/api/subscriptions/${encodeURIComponent(id)}/apply`, {method: "POST", body: {}});
        closeModal();
        toast(result.status === "failed" ? result.error || "The subscription event could not be applied." : "Subscription event processed.", result.status === "failed");
        await navigate("subscriptions");
      }, "Applying…");
    });
  }

  function field(name, label, value = "", options = {}) {
    const id = `setting-${name}`;
    return `<div class="field"><label for="${id}">${esc(label)}${options.optional ? ' <span class="optional">optional</span>' : ""}${options.secret && options.set ? ' <span class="optional mint">saved</span>' : ""}</label><input id="${id}" name="${name}" type="${options.type || "text"}" value="${options.secret ? "" : esc(value)}" placeholder="${esc(options.placeholder || (options.secret && options.set ? "Saved · leave blank to keep" : ""))}" ${options.required ? "required" : ""} ${options.numeric ? 'inputmode="numeric" pattern="[0-9]*"' : ""} autocomplete="${options.secret ? "new-password" : "off"}">${options.hint ? `<small>${esc(options.hint)}</small>` : ""}</div>`;
  }
  function switchRow(name, label, description, checked = false) {
    return `<div class="toggle-row"><div><label for="setting-${name}" class="switch-label">${esc(label)}</label><p class="muted text-tiny mt-4">${esc(description)}</p></div><label class="toggle"><input id="setting-${name}" name="${name}" type="checkbox" ${checked ? "checked" : ""}><span class="toggle-track"></span></label></div>`;
  }
  function renderSettings() {
    const s = state.settings || {};
    const jfUsers = (state.users.jellyfin || []).filter(user => !user.Policy?.IsAdministrator && !user.Policy?.IsDisabled);
    const inviteUrl = safeUrl(s.bot_invite_url);
    return pageHeading("Set your course.", "Connect your servers, choose account permissions, and make Discord delivery your own.") + userWarnings() + `<form id="settings-form"><div class="settings-sections"><section class="panel"><div class="panel-header"><div class="setting-heading"><span class="server-icon emby">${svg("emby")}</span><div><h2>Emby · source server</h2><p>Where your existing users and watch history live.</p></div></div></div><div class="panel-body"><div class="field-row">${field("emby_url", "Server URL", s.emby_url, {type: "url", placeholder: "http://emby:8096", hint: "Use a URL reachable from the Jellyport container."})}${field("emby_api_key", "API key", "", {type: "password", secret: true, set: s.emby_api_key_set, hint: "Generate a key in Emby Dashboard → API Keys."})}</div></div></section><section class="panel"><div class="panel-header"><div class="setting-heading"><span class="server-icon jellyfin">${svg("jellyfin")}</span><div><h2>Jellyfin · destination server</h2><p>The new home for your community.</p></div></div></div><div class="panel-body"><div class="form-stack"><div class="field-row">${field("jellyfin_url", "Server URL", s.jellyfin_url, {type: "url", placeholder: "http://jellyfin:8096", hint: "Used by Jellyport to reach the Jellyfin API."})}${field("jellyfin_api_key", "API key", "", {type: "password", secret: true, set: s.jellyfin_api_key_set, hint: "Generate a key in Jellyfin Dashboard → API Keys."})}</div><div class="field-row">${field("jellyfin_public_url", "Public sign-in URL", s.jellyfin_public_url, {type: "url", optional: true, placeholder: "https://jellyfin.example.com", hint: "Include this address in the user’s credential message."})}<div class="field"><label for="setting-template_user_id">Template user</label><select id="setting-template_user_id" name="template_user_id"><option value="">Choose a Jellyfin user…</option>${jfUsers.map(user => `<option value="${esc(user.Id)}" ${s.template_user_id === user.Id ? "selected" : ""}>${esc(user.Name)}${user.Policy?.IsAdministrator ? " (administrator)" : ""}</option>`).join("")}${s.template_user_id && !jfUsers.some(user => user.Id === s.template_user_id) ? `<option value="${esc(s.template_user_id)}" selected>Saved template · reconnect to view name</option>` : ""}</select><small>New accounts copy this user’s permissions. Existing Jellyfin accounts keep their current policy.</small></div></div><div class="support-note">After saving a new Jellyfin connection, reload Settings to fetch its template users. Use a regular account with the library access you want new members to have.</div></div></div></section><section class="panel"><div class="panel-header"><div><h2>Media path mapping</h2><p>Help Jellyport match media when your servers use different root paths.</p></div>${svg("link")}</div><div class="panel-body"><div class="path-header"><div><h3>Path prefixes</h3><p>Map an Emby prefix to the equivalent Jellyfin prefix. Provider IDs are matched first.</p></div><button class="btn btn-small btn-quiet" type="button" id="add-path">${svg("plus")}Add mapping</button></div><div id="path-mappings">${(s.path_mappings || []).map(mapping => pathMapping(mapping)).join("")}</div><p class="subtle text-tiny mt-13">Example: /mnt/emby/media → /media. Leave empty when paths already match.</p></div></section><section class="panel"><div class="panel-header"><div class="setting-heading"><span class="server-icon discord">${svg("discord")}</span><div><h2>Discord · optional</h2><p>Create accounts by command and deliver credentials privately.</p></div></div></div><div class="panel-body"><div class="form-stack">${switchRow("discord_enabled", "Enable Discord bot", "The bot needs a token, a server, and an authorized admin role.", s.discord_enabled)}<div class="field-row">${field("discord_bot_token", "Bot token", "", {type: "password", secret: true, set: s.discord_bot_token_set, hint: "Stored on the server. Leaving this blank keeps your existing token."})}${field("discord_application_id", "Application ID", s.discord_application_id, {numeric: true, placeholder: "Discord application ID", hint: "Used to generate the bot invite link."})}</div><div class="field-row">${field("discord_guild_id", "Discord server ID", s.discord_guild_id, {numeric: true, placeholder: "Server ID"})}${field("discord_admin_role_id", "Authorized admin role ID", s.discord_admin_role_id, {numeric: true, placeholder: "Role ID", hint: "Only this role and server administrators can run admin commands."})}</div>${field("discord_member_role_id", "Active membership role ID", s.discord_member_role_id, {numeric: true, optional: true, placeholder: "Role granted to active subscribers", hint: "Links subscription access to a Discord role. Its removal can be treated as expiration when role events are enabled."})}${inviteUrl ? `<div><a class="btn btn-quiet" href="${esc(inviteUrl)}" target="_blank" rel="noopener noreferrer">${svg("discord")}Invite bot to your server</a></div>` : '<p class="subtle text-tiny">Save your application ID to generate an invite link.</p>'}<div class="support-note">Enable Developer Mode in Discord to copy user, server, channel, and role IDs. Create your bot in the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Discord Developer Portal</a>. Enable the Server Members intent for role events, and Message Content intent for message events.</div><div class="discord-commands"><h3>Bot commands</h3><div class="command-row"><code>/jellyport create user:@member</code><p>Create a fresh account using the member’s Discord username and deliver credentials privately.</p></div><div class="command-row"><code>/jellyport migrate user:@member emby_username:alex</code><p>Migrate an Emby account and link the member. New links require matching usernames.</p></div><div class="command-row"><code>/jellyport status job_id:…</code><p>Check the result of an account or migration operation.</p></div></div></div></div></section><section class="panel"><div class="panel-header"><div><h2>Membership automation</h2><p>Opt in to automatic changes, or keep membership events in your review queue.</p></div>${svg("inbox")}</div><div class="panel-body"><div class="form-stack">${switchRow("discord_role_events", "Watch membership role changes", "Adding the active role is a subscription event; removing it is an expiration event.", s.discord_role_events)}${switchRow("discord_message_events", "Watch trusted subscription messages", "Only messages from the configured bot and channel are considered.", s.discord_message_events)}<div class="field-row">${field("discord_subscription_channel_id", "Subscription channel ID", s.discord_subscription_channel_id, {numeric: true, optional: true, placeholder: "Trusted announcement channel"})}${field("discord_subscription_bot_id", "Subscription bot user ID", s.discord_subscription_bot_id, {numeric: true, optional: true, placeholder: "Your membership bot’s user ID"})}</div><hr class="m-0">${switchRow("auto_provision", "Automatically provision subscribed members", "Create and deliver accounts automatically. With role events enabled, existing active members are also scanned on startup and every five minutes.", s.auto_provision)}${switchRow("auto_disable", "Automatically disable expired memberships", "Disable the linked Jellyfin account when paid access expires. The account and its history are retained.", s.auto_disable)}${switchRow("disable_on_cancel", "Disable access when a subscription is canceled", "Enable only if access should end at cancellation rather than at the end of the paid period.", s.disable_on_cancel)}<div class="callout warning mb-0">${svg("info")}<div><strong>Start with the review queue.</strong><p>Keep automatic creation and disabling off until your membership events are working as expected. Discord IDs keep links stable when usernames change.</p></div></div></div></div></section></div><div class="settings-actions"><p>Secret values are never returned to this browser.<br>Save changes before testing your connections.</p><div class="button-row"><button class="btn btn-quiet" type="button" id="test-connections">${svg("refresh")}Test saved connections</button><button class="btn btn-primary" type="submit" ${state.session?.demo ? "disabled" : ""}>${svg("check")}Save settings</button></div></div></form><div id="connection-test-results" class="connection-test-results"></div>`;
  }
  function pathMapping(mapping = {}) { return `<div class="path-map"><input aria-label="Emby path prefix" data-path-source value="${esc(mapping.source || "")}" placeholder="Emby: /mnt/media">${svg("arrow")}<input aria-label="Jellyfin path prefix" data-path-target value="${esc(mapping.target || "")}" placeholder="Jellyfin: /media"><button class="icon-button" type="button" data-remove-path aria-label="Remove path mapping">${svg("trash")}</button></div>`; }
  async function saveSettings(form, button) {
    await busy(button, async () => {
      const data = {};
      new FormData(form).forEach((value, key) => { data[key] = String(value).trim(); });
      ["discord_enabled", "discord_role_events", "discord_message_events", "auto_provision", "auto_disable", "disable_on_cancel"].forEach(key => { data[key] = form.elements[key].checked; });
      data.path_mappings = [...document.querySelectorAll(".path-map")].map(row => ({source: row.querySelector("[data-path-source]").value.trim(), target: row.querySelector("[data-path-target]").value.trim()})).filter(row => row.source || row.target);
      if (data.path_mappings.some(row => !row.source || !row.target)) throw new Error("Each path mapping needs both an Emby prefix and a Jellyfin prefix.");
      await api("/api/settings", {method: "PUT", body: data});
      toast("Settings saved. Your connections are ready to test.");
      await navigate("settings");
    }, "Saving…");
  }
  async function testConnections(button) {
    await busy(button, async () => {
      const result = await api("/api/connections/test", {method: "POST", body: {}});
      const connections = result.connections || result;
      const container = document.querySelector("#connection-test-results");
      if (container) container.innerHTML = `<section class="panel"><div class="panel-header"><h2>Saved connection test</h2></div><div class="server-list">${["emby", "jellyfin", "discord"].map(key => { const conn = connections[key] || {}; return `<div class="server-row"><span class="server-icon ${key}">${svg(key)}</span><div class="server-name"><strong>${esc(key === "jellyfin" ? "Jellyfin" : key === "emby" ? "Emby" : "Discord")}</strong><small>${esc(conn.connected ? [conn.name, conn.version].filter(Boolean).join(" · ") || "Connection successful" : conn.error || "Not connected")}</small></div><span class="status ${conn.connected ? "good" : "warn"}">${conn.connected ? "Connected" : "Not connected"}</span></div>`; }).join("")}</div></section>`;
    }, "Testing…");
  }

  function showModal(title, description, body, footer = "", extraClass = "") {
    const originalFocus = modalRoot.previousFocus || document.activeElement;
    closeModal(false);
    state.modalKind = "generic";
    modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal ${extraClass}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><div><h2 id="modal-title">${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ""}</div><button class="icon-button" data-close-modal aria-label="Close dialog">${svg("close")}</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ""}</section></div>`;
    modalRoot.previousFocus = originalFocus;
    document.body.classList.add("modal-open");
    modalRoot.querySelector("button, input, select, [tabindex]")?.focus();
  }
  function closeModal(restoreFocus = true) {
    state.modalJob = null;
    state.modalKind = null;
    modalRoot.replaceChildren();
    document.body.classList.remove("modal-open");
    if (restoreFocus && modalRoot.previousFocus?.isConnected) modalRoot.previousFocus.focus();
    modalRoot.previousFocus = null;
  }
  function progressPercent(job) {
    if (typeof job.progress === "number") return Math.min(100, Math.max(0, job.progress));
    if (job.progress && typeof job.progress === "object") {
      const completed = Number(job.progress.processed || job.progress.completed || job.progress.current || 0);
      const total = Number(job.progress.total || 0);
      return total ? Math.min(100, Math.round(completed / total * 100)) : 0;
    }
    return ["completed", "partial", "failed"].includes(job.status) ? 100 : 0;
  }
  function jobBody(job) {
    const progress = progressPercent(job);
    return `<div class="job-summary"><div><div class="job-id mono">${esc(job.id)}</div><p class="subtle text-tiny mt-5">Started ${esc(date(job.created_at))}</p></div>${status(job.status)}</div>${activeJob(job) ? `<progress class="progress-track" aria-label="Operation progress" value="${progress}" max="100"></progress><p class="muted text-small">${job.status === "queued" ? "Waiting for the operation to begin…" : "The operation is running. Progress updates automatically."}</p>` : ""}${job.error ? `<div class="error-block mt-15">${esc(job.error)}</div>` : ""}${(job.results || []).map(result => `<section class="job-result"><div class="job-result-header"><h3>${esc(result.username || "User")}</h3>${status(result.status)}</div><div class="job-meta">${result.created ? `<span>${svg("userPlus")} New account</span>` : ""}${result.matched !== undefined ? `<span>${num(result.matched)} matched</span>` : ""}${result.applied !== undefined ? `<span class="mint">${num(result.applied)} played updates</span>` : ""}${result.already_played ? `<span>${num(result.already_played)} already played</span>` : ""}${result.unmatched ? `<span>${num(result.unmatched)} unmatched</span>` : ""}${result.ambiguous ? `<span>${num(result.ambiguous)} ambiguous</span>` : ""}</div>${result.discord_delivery ? `<p>${svg("discord")} Discord delivery: ${esc(typeof result.discord_delivery === "string" ? result.discord_delivery : result.discord_delivery.status || JSON.stringify(result.discord_delivery))}</p>` : ""}${result.delivery_error ? `<div class="error-block">${esc(result.delivery_error)}</div>` : ""}${result.error ? `<div class="error-block">${esc(result.error)}</div>` : ""}${previewIssues("Unmatched items", result.unmatched_items, result.unmatched)}${jobAmbiguities(result)}</section>`).join("")}${!(job.results || []).length && !activeJob(job) && !job.error ? '<p class="muted text-small mt-18">This operation has no per-user results.</p>' : ""}${!activeJob(job) ? `<div class="support-note">New account passwords can be revealed once. Existing account passwords are preserved. If Discord delivery failed, reveal and copy the new credentials for manual delivery.</div>` : ""}`;
  }
  function jobFooter(job) {
    const mayHaveCredentials = !activeJob(job) && (job.results || []).some(result => result.created && result.discord_delivery !== "sent");
    return `<button class="btn btn-quiet" data-close-modal>Close</button>${mayHaveCredentials ? `<button class="btn btn-primary" id="reveal-credentials" data-id="${esc(job.id)}">${svg("key")}Reveal new credentials</button>` : ""}`;
  }
  function jobAmbiguities(result) {
    if (!result.ambiguous && !result.ambiguous_items?.length) return "";
    const items = result.ambiguous_items || [];
    return `<details class="disclosure"><summary>Ambiguous items (${num(result.ambiguous || items.length)})</summary>${items.length ? `<ul>${items.map(item => `<li>${esc(item.name || "Unnamed item")}<span class="recovery-target mono">Candidate IDs: ${esc((item.candidate_ids || []).join(", ") || "Unavailable")}</span></li>`).join("")}</ul>` : '<p class="mt-8">These items were skipped because a unique Jellyfin match could not be established.</p>'}</details>`;
  }
  function showJob(job) {
    showModal(["migrate", "migration"].includes(job.kind) ? "Migration details" : "Operation details", "Follow account changes and review delivery results.", jobBody(job), jobFooter(job));
    state.modalKind = "job";
    state.modalJob = job;
    bindJobReveal();
    updatePolling();
  }
  function bindJobReveal() {
    document.querySelector("#reveal-credentials")?.addEventListener("click", event => {
      const id = event.currentTarget.dataset.id;
      showModal("Reveal new account credentials?", "This is a one-time view. Copy credentials before closing the dialog.", `<div class="callout warning mb-0">${svg("key")}<div><strong>Keep this information private.</strong><p>The password is shown only when you request it and is not saved in browser storage. A revealed credential cannot be viewed again.</p></div></div>`, `<button class="btn btn-quiet" data-close-modal>Cancel</button><button class="btn btn-primary" id="confirm-reveal">${svg("key")}Reveal credentials</button>`);
      document.querySelector("#confirm-reveal").addEventListener("click", async click => {
        await busy(click.currentTarget, async () => {
          const result = await api(`/api/jobs/${encodeURIComponent(id)}/credentials`, {method: "POST", body: {}});
          showCredentials(result.credentials || []);
        }, "Revealing…");
      });
    });
  }
  function showCredentials(credentials) {
    showModal("New account credentials", "Copy these now. They cannot be revealed again after this view.", credentials.length ? `<div class="callout warning">${svg("lock")}<div><strong>For the account holder only.</strong><p>Ask members to change their generated password after their first sign-in.</p></div></div>${credentials.map((credential, index) => `<section class="credential"><dl><dt>Username</dt><dd class="mono">${esc(credential.username)}</dd><dt>Password</dt><dd class="credential-password">${esc(credential.password)}</dd><dt>Sign-in URL</dt><dd>${safeUrl(credential.server_url) ? `<a href="${esc(safeUrl(credential.server_url))}" target="_blank" rel="noopener noreferrer">${esc(credential.server_url)}</a>` : "Not configured"}</dd></dl><button class="btn btn-small btn-quiet" data-copy-credential="${index}">${svg("copy")}Copy credentials</button></section>`).join("")}` : empty("key", "No credentials available", "These credentials may already have been revealed, expired, or no new accounts were created."), '<button class="btn btn-primary" data-close-modal>Done</button>');
    state.modalKind = "credentials";
    modalRoot.querySelectorAll("[data-copy-credential]").forEach(button => button.addEventListener("click", async () => {
      const credential = credentials[Number(button.dataset.copyCredential)];
      const value = `Username: ${credential.username}\nPassword: ${credential.password}${credential.server_url ? `\nJellyfin: ${credential.server_url}` : ""}`;
      try {
        await navigator.clipboard.writeText(value);
        toast("Credentials copied. Share them privately with the account holder.");
      } catch { toast("Clipboard access is unavailable. Select and copy the credential text manually.", true); }
    }));
  }
  async function loadJob(id) {
    try { showJob(await api(`/api/jobs/${encodeURIComponent(id)}`)); }
    catch (error) { toast(error.message, true); }
  }

  function bindPage() {
    document.querySelector("#refresh-overview")?.addEventListener("click", () => navigate("overview"));
    document.querySelector("#refresh-activity")?.addEventListener("click", () => navigate("activity"));
    document.querySelector("#refresh-subscriptions")?.addEventListener("click", () => navigate("subscriptions"));
    document.querySelector("#preview-migration")?.addEventListener("click", event => previewMigration(event.currentTarget));
    document.querySelector("#user-search")?.addEventListener("input", event => { state.search = event.currentTarget.value; document.querySelector("#user-table").innerHTML = userTable(); updateSelection(); });
    document.querySelector("#clear-selection")?.addEventListener("click", () => { state.selected.clear(); document.querySelector("#user-table").innerHTML = userTable(); updateSelection(); });
    if (state.page === "migrate") updateSelection();
    document.querySelector("#create-account-form")?.addEventListener("submit", async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = {username: form.elements.username.value.trim(), discord_user_id: form.elements.discord_user_id.value.trim() || undefined};
      if (!data.username) { form.elements.username.focus(); return; }
      await busy(form.querySelector("button[type=submit]"), async () => {
        const job = await api("/api/accounts", {method: "POST", body: data});
        state.jobs = [job, ...state.jobs.filter(existing => existing.id !== job.id)];
        form.reset();
        showJob(job);
        updatePolling();
        toast("Account creation started.");
      }, "Creating account…");
    });
    document.querySelector("#recovery-form")?.addEventListener("submit", event => { event.preventDefault(); inspectRecovery(event.currentTarget, event.currentTarget.querySelector("button[type=submit]")); });
    document.querySelector("#recovery-form")?.addEventListener("input", () => document.querySelector("#recovery-result").replaceChildren());
    document.querySelector("#settings-form")?.addEventListener("submit", event => { event.preventDefault(); saveSettings(event.currentTarget, event.currentTarget.querySelector("button[type=submit]")); });
    document.querySelector("#test-connections")?.addEventListener("click", event => testConnections(event.currentTarget));
    document.querySelector("#add-path")?.addEventListener("click", () => { document.querySelector("#path-mappings").insertAdjacentHTML("beforeend", pathMapping()); document.querySelector("#path-mappings .path-map:last-child input").focus(); });
  }
  document.addEventListener("click", event => {
    const nav = event.target.closest("[data-nav]");
    if (nav) { navigate(nav.dataset.nav); return; }
    const close = event.target.closest("[data-close-modal]");
    if (close) { closeModal(); return; }
    const job = event.target.closest("[data-job]");
    if (job) { loadJob(job.dataset.job); return; }
    const removePath = event.target.closest("[data-remove-path]");
    if (removePath) { removePath.closest(".path-map").remove(); return; }
    const applyEvent = event.target.closest("[data-apply-event]");
    if (applyEvent) { reviewEvent(applyEvent.dataset.applyEvent); return; }
    const ignoreEvent = event.target.closest("[data-ignore-event]");
    if (ignoreEvent) busy(ignoreEvent, async () => { await api(`/api/subscriptions/${encodeURIComponent(ignoreEvent.dataset.ignoreEvent)}/ignore`, {method: "POST", body: {}}); toast("Subscription event ignored."); await navigate("subscriptions"); }, "Ignoring…");
  });
  document.addEventListener("change", event => {
    if (event.target.matches(".user-check")) { if (event.target.checked) state.selected.add(event.target.value); else state.selected.delete(event.target.value); updateSelection(); }
    if (event.target.id === "select-all") { filteredUsers().forEach(user => { if (event.target.checked) state.selected.add(user.Id); else state.selected.delete(user.Id); }); document.querySelector("#user-table").innerHTML = userTable(); updateSelection(); }
  });
  document.addEventListener("keydown", event => {
    if (!modalRoot.firstChild) return;
    if (event.key === "Escape") { event.preventDefault(); closeModal(); }
    if (event.key === "Tab") {
      const elements = [...modalRoot.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length);
      if (!elements.length) { event.preventDefault(); return; }
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !modalRoot.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !modalRoot.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  });

  function stopPolling() { if (state.poll) window.clearInterval(state.poll); state.poll = null; }
  function updatePolling() {
    const active = state.jobs.some(activeJob) || state.overview?.recent_jobs?.some(activeJob) || (state.modalJob && activeJob(state.modalJob));
    if (active && !state.poll && state.session?.authenticated) state.poll = window.setInterval(pollJobs, 3000);
    if (!active) stopPolling();
  }
  async function pollJobs() {
    if (state.pollBusy || !state.session?.authenticated || document.hidden) return;
    state.pollBusy = true;
    try {
      const previousActive = new Set([...state.jobs, ...(state.overview?.recent_jobs || [])].filter(activeJob).map(job => job.id));
      state.jobs = (await api("/api/jobs")).jobs || [];
      const finished = state.jobs.some(job => previousActive.has(job.id) && !activeJob(job));
      if (state.overview) state.overview.recent_jobs = state.jobs.slice(0, 6);
      if (finished && state.page === "migrate") {
        state.users = await api("/api/users");
        if (state.page === "migrate") {
          document.querySelector("#user-table").innerHTML = userTable();
          updateSelection();
        }
      }
      if (state.modalKind === "job" && state.modalJob) {
        const id = state.modalJob.id;
        const job = state.jobs.find(item => item.id === id) || await api(`/api/jobs/${encodeURIComponent(id)}`);
        if (state.modalKind === "job" && state.modalJob?.id === id) {
          state.modalJob = job;
          modalRoot.querySelector(".modal-body").innerHTML = jobBody(job);
          modalRoot.querySelector(".modal-footer").innerHTML = jobFooter(job);
          bindJobReveal();
        }
      }
      if (state.page === "activity") { const scroll = window.scrollY; renderPage(); window.scrollTo(0, scroll); }
      if (state.page === "overview") { state.overview = await api("/api/overview"); renderPage(); }
      updatePolling();
    } catch (error) {
      if (state.session?.authenticated) { stopPolling(); toast(`Progress updates paused: ${error.message} Refresh Activity to retry.`, true); }
    } finally { state.pollBusy = false; }
  }

  async function init() {
    try {
      state.session = await api("/api/session");
      if (state.session.authenticated) { renderShell(); await navigate("overview"); }
      else renderLogin();
    } catch (error) { renderLogin(error.message); }
  }
  init();
})();
