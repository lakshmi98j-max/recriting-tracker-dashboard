/* Recruiting Tracker dashboard.
 *
 * Reads data/contacts.json and data/todos.json (relative paths, so it works on
 * GitHub Pages served from the repo root and from a local http server) and
 * renders the summary tiles, the todo list and the people table. No
 * dependencies, no build step. All data changes happen in the JSON files.
 */
(function () {
  "use strict";

  var CONTACTS_URL = "data/contacts.json";
  var TODOS_URL = "data/todos.json";
  var MS_PER_DAY = 86400000;

  // The Mark done / Reopen buttons commit data/todos.json through the GitHub
  // contents API. The token lives in localStorage on this origin only.
  var KEY_TOKEN = "tracker.github.token";
  var KEY_REPO = "tracker.github.repo";
  var KEY_API_BASE = "tracker.github.apiBase"; // override for GitHub Enterprise or tests
  var DEFAULT_API_BASE = "https://api.github.com";

  var STAGE_LABELS = {
    to_reach_out: "To reach out",
    emailed: "Emailed",
    follow_up_needed: "Follow-up needed",
    response_received: "Response received",
    call_scheduled: "Call scheduled",
    closed: "Closed"
  };
  var PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

  var state = {
    contacts: [],
    todos: [],
    contactsById: {},
    contactsUpdated: null,
    todosUpdated: null,
    live: false,
    expanded: {}
  };

  var github = { repo: "", branch: "main", token: "", apiBase: DEFAULT_API_BASE };
  var pendingAction = null;
  var toastTimer = null;

  var el = {};

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function parseDate(value) {
    if (!value || typeof value !== "string") return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  function startOfToday() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Whole days from today to the given date. Negative means the date is in the past.
  function daysFromToday(value) {
    var d = parseDate(value);
    if (!d) return null;
    return Math.round((d.getTime() - startOfToday().getTime()) / MS_PER_DAY);
  }

  function formatDate(value) {
    var d = parseDate(value);
    if (!d) return "";
    var opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function relativeDue(value, noun) {
    var n = daysFromToday(value);
    if (n === null) return { text: "no " + noun, cls: "none" };
    if (n < 0) return { text: "overdue by " + plural(-n, "day"), cls: "overdue" };
    if (n === 0) return { text: "due today", cls: "today" };
    if (n === 1) return { text: "due tomorrow", cls: "soon" };
    if (n <= 3) return { text: "due in " + plural(n, "day"), cls: "soon" };
    return { text: "due " + formatDate(value), cls: "later" };
  }

  function daysSince(value) {
    var n = daysFromToday(value);
    return n === null ? null : -n;
  }

  function isSample(record) {
    return /^sample\b/i.test(record.name || record.title || "") || /sample row/i.test(record.notes || "");
  }

  function sampleTag(record) {
    return isSample(record) ? '<span class="sample-tag">sample</span>' : "";
  }

  function link(href, text) {
    return '<a class="link" href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' + escapeHtml(text) + "</a>";
  }

  // A contact the owner has decided to answer on a later date: nothing is
  // owed until then, so tiles and summaries leave them out.
  function isSnoozed(contact) {
    var n = daysFromToday(contact.respond_on);
    return n !== null && n > 0;
  }

  function isAwaitingMyReply(contact) {
    return contact.last_touch_by === "them" && contact.stage !== "closed" && !isSnoozed(contact);
  }

  function todayIso() {
    var d = new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function storageSet(key, value) {
    try {
      if (value == null || value === "") window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function metaContent(name) {
    var node = document.querySelector('meta[name="' + name + '"]');
    return node ? (node.getAttribute("content") || "").trim() : "";
  }

  function utf8ToBase64(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToUtf8(b64) {
    var bin = atob(String(b64).replace(/\s+/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function toast(message, isError) {
    el.toast.textContent = message;
    el.toast.className = "toast" + (isError ? " error" : "");
    el.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, isError ? 12000 : 7000);
  }

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------

  function loadJson(url) {
    // The query string defeats the GitHub Pages CDN cache, which otherwise
    // serves a data file for up to 10 minutes after a commit.
    var busted = url + (url.indexOf("?") === -1 ? "?" : "&") + "v=" + Date.now();
    return fetch(busted, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error(url + " returned HTTP " + res.status);
      return res.json();
    });
  }

  // With a token, read the files straight from the repository through the
  // GitHub API: always the latest commit, no Pages build delay, no CDN cache.
  function loadFromGithub(path) {
    return githubRequest("GET", "/repos/" + github.repo + "/contents/" + path + "?ref=" + encodeURIComponent(github.branch))
      .then(function (file) {
        if (!file || !file.content) throw new Error("Unexpected response from GitHub for " + path);
        return JSON.parse(base64ToUtf8(file.content));
      });
  }

  function loadData() {
    if (github.token && github.repo) {
      return Promise.all([loadFromGithub(CONTACTS_URL), loadFromGithub(TODOS_URL)]).then(function (results) {
        return { results: results, live: true };
      }, function (err) {
        // Fall back to the published copy so a bad token never blanks the page.
        return Promise.all([loadJson(CONTACTS_URL), loadJson(TODOS_URL)]).then(function (results) {
          return { results: results, live: false, warning: err && err.message ? err.message : String(err) };
        });
      });
    }
    return Promise.all([loadJson(CONTACTS_URL), loadJson(TODOS_URL)]).then(function (results) {
      return { results: results, live: false };
    });
  }

  function unwrap(payload, key) {
    if (Array.isArray(payload)) return { rows: payload, updated: null };
    if (payload && Array.isArray(payload[key])) return { rows: payload[key], updated: payload.updated_at || null };
    throw new Error("Unexpected shape in " + key + " file: expected an object with a \"" + key + "\" list");
  }

  function showError(message) {
    var hint = "";
    if (window.location.protocol === "file:") {
      hint = " Browsers block fetch() on file:// pages. Run <code>python3 -m http.server 8000</code> in the repo and open <code>http://localhost:8000/</code>, or use the GitHub Pages URL.";
    }
    el.error.innerHTML = "<strong>Could not load data.</strong> " + escapeHtml(message) + hint;
    el.error.hidden = false;
    el.meta.textContent = "Data failed to load.";
  }

  // The page is hosted without data files when the data repo is private:
  // there is nothing to show until a token is connected.
  function showConnectPrompt() {
    el.error.innerHTML = "<strong>Connect GitHub to load your tracker.</strong> This page holds no data. Click Connect GitHub and paste a token for <code>" + escapeHtml(github.repo || "your data repository") + "</code>; contacts and todos are then read straight from that repository.";
    el.error.hidden = false;
    el.meta.textContent = "Not connected.";
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function renderMeta() {
    var parts = [];
    parts.push(plural(state.contacts.length, "contact") + ", " + plural(state.todos.length, "todo"));
    if (state.contactsUpdated) parts.push("contacts updated " + state.contactsUpdated);
    if (state.todosUpdated) parts.push("todos updated " + state.todosUpdated);
    parts.push(state.live ? "live from GitHub" : "published copy");
    el.meta.textContent = parts.join(" · ");
  }

  function renderTiles() {
    var open = state.todos.filter(function (t) { return t.status === "open"; });
    var high = open.filter(function (t) { return t.priority === "high"; });
    var followUps = state.contacts.filter(function (c) { return c.stage === "follow_up_needed" && !isSnoozed(c); });
    var awaiting = state.contacts.filter(isAwaitingMyReply);
    byId("tile-open").textContent = open.length;
    byId("tile-high").textContent = high.length;
    byId("tile-follow").textContent = followUps.length;
    byId("tile-awaiting").textContent = awaiting.length;
  }

  function todoSort(a, b) {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    var pa = PRIORITY_RANK[a.priority], pb = PRIORITY_RANK[b.priority];
    pa = pa == null ? 9 : pa;
    pb = pb == null ? 9 : pb;
    if (pa !== pb) return pa - pb;
    var da = parseDate(a.due), db = parseDate(b.due);
    if (da && db && da.getTime() !== db.getTime()) return da.getTime() - db.getTime();
    if (da && !db) return -1;
    if (!da && db) return 1;
    return String(a.id).localeCompare(String(b.id));
  }

  function todoHtml(t) {
    var contact = t.contact_id ? state.contactsById[t.contact_id] : null;
    var due;
    if (t.status === "done") {
      due = { text: t.completed ? "done " + formatDate(t.completed) : "done", cls: "done" };
    } else {
      due = relativeDue(t.due, "due date");
    }
    var bits = [];
    bits.push('<span class="pill priority-' + escapeHtml(t.priority) + '">' + escapeHtml(t.priority) + "</span>");
    bits.push('<span class="due ' + due.cls + '">' + escapeHtml(due.text) + "</span>");
    if (t.company) bits.push("<span>" + escapeHtml(t.company) + "</span>");
    if (contact) bits.push("<span>" + escapeHtml(contact.name) + "</span>");
    if (t.source_thread_url) bits.push(link(t.source_thread_url, "Gmail thread"));
    var action = t.status === "open"
      ? '<button type="button" class="btn btn-small" data-action="done" data-id="' + escapeHtml(t.id) + '">Mark done</button>'
      : '<button type="button" class="btn btn-small btn-quiet" data-action="open" data-id="' + escapeHtml(t.id) + '">Reopen</button>';
    return (
      '<li class="todo status-' + escapeHtml(t.status) + " priority-" + escapeHtml(t.priority) + (isSample(t) ? " sample" : "") + '" data-id="' + escapeHtml(t.id) + '">' +
      '<div class="todo-row">' +
      '<div class="todo-main">' +
      '<div class="todo-title">' + escapeHtml(t.title) + sampleTag(t) + "</div>" +
      '<div class="todo-meta">' + bits.join('<span class="sep">|</span>') + "</div>" +
      (t.notes ? '<div class="todo-notes">' + escapeHtml(t.notes) + "</div>" : "") +
      "</div>" +
      '<div class="todo-actions">' + action + "</div>" +
      "</div>" +
      "</li>"
    );
  }

  function renderTodos() {
    var status = el.todoStatus.value;
    var priority = el.todoPriority.value;
    var rows = state.todos.filter(function (t) {
      if (status !== "all" && t.status !== status) return false;
      if (priority !== "all" && t.priority !== priority) return false;
      return true;
    }).sort(todoSort);
    el.todoCount.textContent = rows.length + " of " + state.todos.length;
    el.todoList.innerHTML = rows.map(todoHtml).join("");
    el.todoEmpty.hidden = rows.length > 0;
  }

  function peopleSort(a, b) {
    // Soonest next action first, then most recently touched, then name.
    var na = parseDate(a.next_action_date), nb = parseDate(b.next_action_date);
    if (na && nb && na.getTime() !== nb.getTime()) return na.getTime() - nb.getTime();
    if (na && !nb) return -1;
    if (!na && nb) return 1;
    var la = parseDate(a.last_touch), lb = parseDate(b.last_touch);
    if (la && lb && la.getTime() !== lb.getTime()) return lb.getTime() - la.getTime();
    if (la && !lb) return -1;
    if (!la && lb) return 1;
    return String(a.name || "").localeCompare(String(b.name || ""));
  }

  function hasDetails(c) {
    return true; // every row has the plan and notes panel
  }

  function planHtml(c) {
    var notes = Array.isArray(c.owner_notes) ? c.owner_notes : [];
    var noteItems = notes.map(function (n) {
      return '<li><span class="note-date">' + escapeHtml(formatDate(n.date)) + "</span>" + escapeHtml(n.text) + "</li>";
    }).join("");
    var respond = c.respond_on || "";
    var snoozed = isSnoozed(c);
    return (
      '<div class="details-block details-plan">' +
      '<div class="details-title">My plan and notes</div>' +
      '<form class="plan-form" data-form="respond-on" data-id="' + escapeHtml(c.id) + '">' +
      "<label>Respond on " +
      '<input type="date" name="respond_on" value="' + escapeHtml(respond) + '">' +
      "</label>" +
      '<button type="submit" class="btn btn-small">Save date</button>' +
      (respond ? '<button type="button" class="btn btn-small btn-quiet" data-action="clear-respond-on" data-id="' + escapeHtml(c.id) + '">Clear</button>' : "") +
      (snoozed ? '<span class="plan-state">Snoozed until ' + escapeHtml(formatDate(respond)) + ", nothing is due before then</span>" : "") +
      "</form>" +
      (noteItems ? '<ul class="notes-list">' + noteItems + "</ul>" : "") +
      '<form class="note-form" data-form="note" data-id="' + escapeHtml(c.id) + '">' +
      '<textarea name="note" rows="2" maxlength="1000" placeholder="A note only you write. The agent reads it when drafting and never changes it."></textarea>' +
      '<button type="submit" class="btn btn-small">Add note</button>' +
      "</form>" +
      "</div>"
    );
  }

  function detailsHtml(c) {
    var blocks = [];
    if (c.last_message && c.last_message.excerpt) {
      var lm = c.last_message;
      var who = lm.from === "me" ? "from me" : "from " + (lm.sender || "them");
      blocks.push(
        '<div class="details-block">' +
        '<div class="details-title">Last message, ' + escapeHtml(formatDate(lm.date)) + ", " + escapeHtml(who) + "</div>" +
        '<pre class="details-text">' + escapeHtml(lm.excerpt) + "</pre>" +
        "</div>"
      );
    }
    if (c.draft_reply) {
      blocks.push(
        '<div class="details-block">' +
        '<div class="details-title">Draft reply' +
        '<span class="details-actions">' +
        '<button type="button" class="btn btn-small" data-action="copy-draft" data-id="' + escapeHtml(c.id) + '">Copy</button>' +
        (c.thread_url ? link(c.thread_url, "Open thread") : "") +
        "</span></div>" +
        '<pre class="details-text">' + escapeHtml(c.draft_reply) + "</pre>" +
        '<div class="details-note">Nothing is sent from here. Copy it, paste it into Gmail, adjust, send.</div>' +
        "</div>"
      );
    }
    blocks.push(planHtml(c));
    return '<tr class="details-row"><td colspan="6"><div class="details">' + blocks.join("") + "</div></td></tr>";
  }

  function personHtml(c) {
    var since = daysSince(c.last_touch);
    var sinceText = since === null ? "never" : since === 0 ? "today" : since < 0 ? "in " + plural(-since, "day") : plural(since, "day") + " ago";
    var by = c.last_touch_by ? " by " + c.last_touch_by : "";
    var nextDate = c.next_action_date ? relativeDue(c.next_action_date, "date") : null;
    var expanded = !!state.expanded[c.id];
    var detailsButton = hasDetails(c)
      ? '<button type="button" class="btn btn-small btn-quiet details-toggle" data-action="toggle-details" data-id="' + escapeHtml(c.id) + '" aria-expanded="' + expanded + '">' + (expanded ? "Hide" : "Details") + (c.draft_reply && !expanded ? '<span class="draft-dot" title="Draft reply ready"></span>' : "") + "</button>"
      : "";
    var stageButton = c.stage === "closed"
      ? '<button type="button" class="btn btn-small btn-quiet" data-action="reopen-contact" data-id="' + escapeHtml(c.id) + '">Reopen</button>'
      : '<button type="button" class="btn btn-small btn-quiet" data-action="close-contact" data-id="' + escapeHtml(c.id) + '" title="Mark this person closed; only you can do that">Close</button>';
    return (
      "<tr" + (isSample(c) ? ' class="sample"' : "") + ' data-id="' + escapeHtml(c.id) + '">' +
      '<td><div class="primary">' + escapeHtml(c.name) + sampleTag(c) + "</div>" +
      (c.email ? '<div class="secondary">' + escapeHtml(c.email) + "</div>" : "") + "</td>" +
      '<td><div class="primary">' + escapeHtml(c.company) + "</div>" +
      (c.role ? '<div class="secondary">' + escapeHtml(c.role) + "</div>" : "") + "</td>" +
      '<td><span class="pill stage-' + escapeHtml(c.stage) + '">' + escapeHtml(STAGE_LABELS[c.stage] || c.stage) + "</span></td>" +
      '<td><div class="primary">' + escapeHtml(sinceText) + "</div>" +
      (c.last_touch ? '<div class="secondary">' + escapeHtml(formatDate(c.last_touch) + by) + "</div>" : "") + "</td>" +
      '<td><div class="primary">' + (c.next_action ? escapeHtml(c.next_action) : '<span class="muted">none</span>') + "</div>" +
      (isSnoozed(c)
        ? '<div class="secondary due later">respond on ' + escapeHtml(formatDate(c.respond_on)) + "</div>"
        : (nextDate ? '<div class="secondary due ' + nextDate.cls + '">' + escapeHtml(nextDate.text) + "</div>" : "")) + "</td>" +
      '<td class="thread-cell"><div class="row-actions">' + (c.thread_url ? link(c.thread_url, "Open") : '<span class="muted">none</span>') + detailsButton + stageButton + "</div></td>" +
      "</tr>" +
      (expanded ? detailsHtml(c) : "")
    );
  }

  function renderPeople() {
    var stage = el.peopleStage.value;
    var q = el.peopleSearch.value.trim().toLowerCase();
    var rows = state.contacts.filter(function (c) {
      if (stage === "active" && c.stage === "closed") return false;
      if (stage === "awaiting" && !isAwaitingMyReply(c)) return false;
      if (stage !== "all" && stage !== "active" && stage !== "awaiting" && c.stage !== stage) return false;
      if (q) {
        var hay = [c.name, c.email, c.company, c.role, c.next_action, c.notes, c.source, STAGE_LABELS[c.stage]]
          .join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).sort(peopleSort);
    el.peopleCount.textContent = rows.length + " of " + state.contacts.length;
    el.peopleBody.innerHTML = rows.map(personHtml).join("");
    el.peopleEmpty.hidden = rows.length > 0;
  }

  function render() {
    renderMeta();
    renderTiles();
    renderTodos();
    renderPeople();
  }

  // ------------------------------------------------------------------
  // GitHub: save todo status changes straight to the repo
  // ------------------------------------------------------------------

  function defaultRepo() {
    var meta = metaContent("tracker-repo");
    if (meta) return meta;
    // On GitHub Pages the owner is the subdomain and the repo is the first path segment.
    var m = /^([^.]+)\.github\.io$/i.exec(window.location.hostname);
    if (m) {
      var first = window.location.pathname.split("/").filter(Boolean)[0];
      if (first) return m[1] + "/" + first;
    }
    return "";
  }

  function loadGithubSettings() {
    github.branch = metaContent("tracker-branch") || "main";
    github.repo = storageGet(KEY_REPO) || defaultRepo();
    github.token = storageGet(KEY_TOKEN) || "";
    github.apiBase = storageGet(KEY_API_BASE) || DEFAULT_API_BASE;
  }

  function renderGithubState() {
    if (github.token) {
      el.githubState.textContent = "Connected to " + github.repo;
      el.githubConnect.textContent = "GitHub settings";
    } else {
      el.githubState.textContent = "Read only";
      el.githubConnect.textContent = "Connect GitHub";
    }
  }

  function githubErrorMessage(status, data) {
    var detail = data && data.message ? " (" + data.message + ")" : "";
    if (status === 401) return "GitHub rejected the token. Check it was pasted in full and has not expired." + detail;
    if (status === 403 || status === 404) return "The token cannot write to " + github.repo + ". It needs Contents: Read and write on that repository, and the repository name must be exact." + detail;
    return "GitHub returned HTTP " + status + detail;
  }

  function githubRequest(method, path, body) {
    var headers = {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + github.token,
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (body) headers["Content-Type"] = "application/json";
    return fetch(github.apiBase + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error(githubErrorMessage(res.status, data));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }, function () {
      throw new Error("Could not reach the GitHub API. Check your connection.");
    });
  }

  function findTodo(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    if (busy) {
      button.setAttribute("data-label", button.textContent);
      button.textContent = "Saving...";
    } else if (button.getAttribute("data-label")) {
      button.textContent = button.getAttribute("data-label");
      button.removeAttribute("data-label");
    }
  }

  // Read a data file from the repo, let mutateList change it, write it back
  // as a commit. mutateList(list, today) returns the records it changed; an
  // empty result means nothing is written. Retries once when the file changed
  // under us (409 or 422).
  function saveFile(filePath, listKey, mutateList, message) {
    var path = "/repos/" + github.repo + "/contents/" + filePath;
    var today = todayIso();

    function attempt(retriesLeft) {
      return githubRequest("GET", path + "?ref=" + encodeURIComponent(github.branch)).then(function (file) {
        if (!file || !file.content || !file.sha) throw new Error("Unexpected response from GitHub when reading " + filePath + ".");
        var data = JSON.parse(base64ToUtf8(file.content));
        var list = Array.isArray(data) ? data : data[listKey];
        if (!Array.isArray(list)) throw new Error(filePath + " on GitHub has an unexpected shape.");
        var changed = mutateList(list, today) || [];
        if (!changed.length) return changed;
        changed.forEach(function (record) { record.updated_at = today; });
        if (!Array.isArray(data)) data.updated_at = today;
        var body = {
          message: message,
          content: utf8ToBase64(JSON.stringify(data, null, 2) + "\n"),
          sha: file.sha,
          branch: github.branch
        };
        return githubRequest("PUT", path, body).then(function () { return changed; });
      }).catch(function (err) {
        if ((err.status === 409 || err.status === 422) && retriesLeft > 0) return attempt(retriesLeft - 1);
        throw err;
      });
    }
    return attempt(1);
  }

  function saveRecord(filePath, listKey, id, mutate, message) {
    return saveFile(filePath, listKey, function (list, today) {
      var record = findTodo(list, id);
      if (!record) throw new Error(id + " is not in the latest " + filePath + " on GitHub. Reload the page.");
      mutate(record, today);
      return [record];
    }, message).then(function (changed) { return changed[0]; });
  }

  // Without a token, remember what was asked and open the connect dialog;
  // the action runs once the token is saved.
  function requireToken(run, message) {
    if (github.token) return true;
    pendingAction = { run: run };
    openGithubDialog(message || "Connect GitHub once to save changes from this page.");
    return false;
  }

  function copyContactFields(id, saved) {
    var local = state.contactsById[id];
    if (!local) return;
    ["stage", "next_action", "next_action_date", "draft_reply", "history", "respond_on", "owner_notes", "updated_at"].forEach(function (key) {
      if (key in saved) local[key] = saved[key];
    });
  }

  function setTodoStatus(id, status, button) {
    if (!requireToken(function () { setTodoStatus(id, status, el.todoList.querySelector('button[data-id="' + id + '"]')); })) return;
    setBusy(button, true);
    saveRecord(TODOS_URL, "todos", id, function (todo, today) {
      todo.status = status;
      todo.completed = status === "done" ? today : null;
    }, "update: " + id + (status === "done" ? " done" : " reopened") + " (dashboard)").then(function (saved) {
      var local = findTodo(state.todos, id);
      if (local) {
        local.status = saved.status;
        local.completed = saved.completed;
        local.updated_at = saved.updated_at;
      }
      state.todosUpdated = saved.updated_at;
      state.live = true;
      render();
      toast("Saved " + id + " to GitHub.");
    }).catch(function (err) {
      setBusy(button, false);
      toast(err && err.message ? err.message : String(err), true);
    });
  }

  // The stage a reopened contact gets, following the derivation rules the
  // agent uses: who touched last, and how long ago.
  function derivedStage(contact, today) {
    if (contact.last_touch_by === "them") return "response_received";
    if (contact.last_touch_by === "me" && contact.last_touch) {
      var days = -daysFromToday(contact.last_touch);
      return days >= 4 ? "follow_up_needed" : "emailed";
    }
    return "to_reach_out";
  }

  function setContactStage(id, action, button) {
    if (!requireToken(function () { setContactStage(id, action, el.peopleBody.querySelector('button[data-action][data-id="' + id + '"]')); })) return;
    setBusy(button, true);
    var closing = action === "close";
    saveRecord(CONTACTS_URL, "contacts", id, function (contact, today) {
      if (!Array.isArray(contact.history)) contact.history = [];
      if (closing) {
        contact.stage = "closed";
        contact.next_action = null;
        contact.next_action_date = null;
        contact.draft_reply = null;
        contact.history.push({ date: today, event: "Closed from the dashboard" });
      } else {
        contact.stage = derivedStage(contact, today);
        contact.history.push({ date: today, event: "Reopened from the dashboard" });
      }
    }, "update: " + id + (closing ? " closed" : " reopened") + " (dashboard)").then(function (saved) {
      copyContactFields(id, saved);
      state.contactsUpdated = saved.updated_at;
      state.live = true;
      render();
      toast((closing ? "Closed " : "Reopened ") + id + " and saved to GitHub.");
    }).catch(function (err) {
      setBusy(button, false);
      toast(err && err.message ? err.message : String(err), true);
    });
  }

  // "I will respond on this date": owner-only field. Also moves the due date
  // of the contact's open todos to that day so the list agrees.
  function setRespondOn(id, dateStr, button) {
    if (!requireToken(function () { setRespondOn(id, dateStr, null); })) return;
    setBusy(button, true);
    var message = "update: " + id + (dateStr ? " respond on " + dateStr : " respond date cleared") + " (dashboard)";
    saveRecord(CONTACTS_URL, "contacts", id, function (contact) {
      contact.respond_on = dateStr || null;
    }, message).then(function (saved) {
      copyContactFields(id, saved);
      state.contactsUpdated = saved.updated_at;
      if (!dateStr) return [];
      return saveFile(TODOS_URL, "todos", function (list) {
        return list.filter(function (t) { return t.contact_id === id && t.status === "open" && t.due !== dateStr; })
          .map(function (t) { t.due = dateStr; return t; });
      }, "update: todos for " + id + " due " + dateStr + " (dashboard)");
    }).then(function (changedTodos) {
      (changedTodos || []).forEach(function (t) {
        var local = findTodo(state.todos, t.id);
        if (local) { local.due = t.due; local.updated_at = t.updated_at; }
      });
      state.live = true;
      render();
      toast(dateStr ? "Saved: respond on " + formatDate(dateStr) + "." : "Respond date cleared.");
    }).catch(function (err) {
      setBusy(button, false);
      toast(err && err.message ? err.message : String(err), true);
    });
  }

  // Append-only notes from the owner. The agent reads them, never edits them.
  function addOwnerNote(id, text, button) {
    if (!requireToken(function () { addOwnerNote(id, text, null); })) return;
    setBusy(button, true);
    saveRecord(CONTACTS_URL, "contacts", id, function (contact, today) {
      if (!Array.isArray(contact.owner_notes)) contact.owner_notes = [];
      contact.owner_notes.push({ date: today, text: text });
    }, "update: " + id + " note (dashboard)").then(function (saved) {
      copyContactFields(id, saved);
      state.contactsUpdated = saved.updated_at;
      state.live = true;
      render();
      toast("Note saved.");
    }).catch(function (err) {
      setBusy(button, false);
      toast(err && err.message ? err.message : String(err), true);
    });
  }

  function openGithubDialog(message) {
    el.githubRepo.value = github.repo;
    el.githubToken.value = "";
    el.githubToken.placeholder = github.token ? "saved in this browser, paste to replace" : "github_pat_...";
    el.githubDisconnect.hidden = !github.token;
    el.githubError.hidden = !message;
    el.githubError.textContent = message || "";
    if (typeof el.githubDialog.showModal === "function") el.githubDialog.showModal();
    else el.githubDialog.setAttribute("open", "");
    (github.token ? el.githubRepo : el.githubToken).focus();
  }

  function closeGithubDialog() {
    if (typeof el.githubDialog.close === "function" && el.githubDialog.open) el.githubDialog.close();
    else el.githubDialog.removeAttribute("open");
  }

  function onGithubSave(event) {
    event.preventDefault();
    var repo = el.githubRepo.value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/+$/, "");
    var token = el.githubToken.value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      el.githubError.textContent = "Repository must look like owner/repo.";
      el.githubError.hidden = false;
      return;
    }
    if (!token && !github.token) {
      el.githubError.textContent = "Paste a token to continue.";
      el.githubError.hidden = false;
      return;
    }
    github.repo = repo;
    storageSet(KEY_REPO, repo);
    if (token) {
      github.token = token;
      if (!storageSet(KEY_TOKEN, token)) {
        toast("This browser blocks storage, so the token is kept for this page load only.", true);
      }
    }
    closeGithubDialog();
    renderGithubState();
    if (pendingAction) {
      var action = pendingAction;
      pendingAction = null;
      action.run();
    } else if (token) {
      // A fresh token means the page can now read the live files; reload them.
      loadAndRender();
    }
  }

  function onGithubDisconnect() {
    github.token = "";
    storageSet(KEY_TOKEN, null);
    pendingAction = null;
    closeGithubDialog();
    renderGithubState();
    toast("Token removed from this browser.");
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------

  function onTileClick(event) {
    var tile = event.currentTarget.getAttribute("data-tile");
    if (tile === "open") {
      el.todoStatus.value = "open";
      el.todoPriority.value = "all";
      renderTodos();
      byId("todos-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (tile === "high") {
      el.todoStatus.value = "open";
      el.todoPriority.value = "high";
      renderTodos();
      byId("todos-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (tile === "follow") {
      el.peopleStage.value = "follow_up_needed";
      renderPeople();
      byId("people-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (tile === "awaiting") {
      el.peopleStage.value = "awaiting";
      renderPeople();
      byId("people-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function onTodoListClick(event) {
    var button = event.target.closest ? event.target.closest("button[data-action]") : null;
    if (!button || button.disabled) return;
    var status = button.getAttribute("data-action") === "done" ? "done" : "open";
    setTodoStatus(button.getAttribute("data-id"), status, button);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(area);
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }

  function onPeopleClick(event) {
    var button = event.target.closest ? event.target.closest("button[data-action]") : null;
    if (!button || button.disabled) return;
    var id = button.getAttribute("data-id");
    var action = button.getAttribute("data-action");
    if (action === "close-contact") {
      setContactStage(id, "close", button);
    } else if (action === "reopen-contact") {
      setContactStage(id, "reopen", button);
    } else if (action === "clear-respond-on") {
      setRespondOn(id, "", button);
    } else if (action === "toggle-details") {
      if (state.expanded[id]) delete state.expanded[id];
      else state.expanded[id] = true;
      renderPeople();
    } else if (action === "copy-draft") {
      var contact = state.contactsById[id];
      if (!contact || !contact.draft_reply) return;
      copyText(contact.draft_reply).then(function () {
        toast("Draft copied. Paste it into Gmail, adjust, and send.");
      }, function () {
        toast("Could not copy automatically; select the text and copy it.", true);
      });
    }
  }

  function onPeopleSubmit(event) {
    var form = event.target;
    if (!form || !form.getAttribute) return;
    var kind = form.getAttribute("data-form");
    if (!kind) return;
    event.preventDefault();
    var id = form.getAttribute("data-id");
    var button = form.querySelector('button[type="submit"]');
    if (kind === "respond-on") {
      var dateStr = form.querySelector('input[name="respond_on"]').value.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { toast("Pick a date first.", true); return; }
      setRespondOn(id, dateStr, button);
    } else if (kind === "note") {
      var text = form.querySelector('textarea[name="note"]').value.trim();
      if (!text) { toast("Write the note first.", true); return; }
      addOwnerNote(id, text, button);
    }
  }

  function bind() {
    el.todoStatus.addEventListener("change", renderTodos);
    el.todoPriority.addEventListener("change", renderTodos);
    el.peopleStage.addEventListener("change", renderPeople);
    el.peopleSearch.addEventListener("input", renderPeople);
    el.todoList.addEventListener("click", onTodoListClick);
    el.peopleBody.addEventListener("click", onPeopleClick);
    el.peopleBody.addEventListener("submit", onPeopleSubmit);
    el.githubConnect.addEventListener("click", function () { openGithubDialog(""); });
    el.githubForm.addEventListener("submit", onGithubSave);
    el.githubCancel.addEventListener("click", function () { pendingAction = null; closeGithubDialog(); });
    el.githubDisconnect.addEventListener("click", onGithubDisconnect);
    var tiles = document.querySelectorAll(".tile[data-tile]");
    for (var i = 0; i < tiles.length; i++) tiles[i].addEventListener("click", onTileClick);
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------

  function init() {
    el.error = byId("error");
    el.meta = byId("meta");
    el.todoStatus = byId("todo-status");
    el.todoPriority = byId("todo-priority");
    el.todoList = byId("todo-list");
    el.todoEmpty = byId("todo-empty");
    el.todoCount = byId("todo-count");
    el.peopleStage = byId("people-stage");
    el.peopleSearch = byId("people-search");
    el.peopleBody = byId("people-body");
    el.peopleEmpty = byId("people-empty");
    el.peopleCount = byId("people-count");
    el.toast = byId("toast");
    el.githubState = byId("github-state");
    el.githubConnect = byId("github-connect");
    el.githubDialog = byId("github-dialog");
    el.githubForm = byId("github-form");
    el.githubRepo = byId("github-repo");
    el.githubToken = byId("github-token");
    el.githubError = byId("github-error");
    el.githubCancel = byId("github-cancel");
    el.githubDisconnect = byId("github-disconnect");
    loadGithubSettings();
    renderGithubState();
    bind();
    loadAndRender();
  }

  function loadAndRender() {
    loadData()
      .then(function (loaded) {
        var contacts = unwrap(loaded.results[0], "contacts");
        var todos = unwrap(loaded.results[1], "todos");
        state.contacts = contacts.rows;
        state.todos = todos.rows;
        state.contactsUpdated = contacts.updated;
        state.todosUpdated = todos.updated;
        state.live = loaded.live;
        state.contactsById = {};
        state.contacts.forEach(function (c) { state.contactsById[c.id] = c; });
        el.error.hidden = true;
        render();
        document.body.setAttribute("data-loaded", "true");
        if (loaded.warning) toast("Showing the published copy. GitHub API read failed: " + loaded.warning, true);
      })
      .catch(function (err) {
        var message = err && err.message ? err.message : String(err);
        if (!github.token && /HTTP 404/.test(message)) showConnectPrompt();
        else showError(message);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
