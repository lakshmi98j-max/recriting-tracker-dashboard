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
  var OTHER_URL = "data/other_todos.json";
  var QUESTIONS_URL = "data/questions.json";
  var TABS = ["recruiting", "other", "ask"];
  var ANSWER_LABELS = { track: "Track as recruiting", skip: "Not recruiting", other_todo: "Make it an Other todo" };
  var QUESTION_KIND_LABELS = { recruiting_or_not: "Is this recruiting mail?", closed_owner_wrote: "You wrote to someone you closed", other: "Question" };

  // The two todo lists: recruiting (linked to people) and everything else the
  // agent finds in the mail. Separate files, separate id prefixes.
  var KINDS = {
    recruiting: { name: "recruiting", url: TODOS_URL, prefix: "t_", stateKey: "todos", updatedKey: "todosUpdated" },
    other: { name: "other", url: OTHER_URL, prefix: "o_", stateKey: "other", updatedKey: "otherUpdated" }
  };
  var OTHER_CATEGORIES = ["school", "finance", "admin", "health", "housing", "personal", "other"];
  var CATEGORY_LABELS = {
    school: "School", finance: "Money", admin: "Admin", health: "Health", housing: "Housing", personal: "Personal", other: "Other"
  };
  var MS_PER_DAY = 86400000;

  // The Mark done / Reopen buttons commit data/todos.json through the GitHub
  // contents API. The token lives in localStorage on this origin only.
  var KEY_TOKEN = "tracker.github.token";
  var KEY_REPO = "tracker.github.repo";
  var KEY_API_BASE = "tracker.github.apiBase"; // override for GitHub Enterprise or tests
  var KEY_SHOW_LINKED = "tracker.todos.showLinked"; // per-browser preference for the Show all switch
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

  // The people list shows one conversation group at a time. Which group a
  // person is in follows from who wrote last and whether they have ever
  // written at all.
  var GROUPS = ["needs_reply", "no_reply", "in_conversation", "closed", "all"];
  var GROUP_NOTES = {
    needs_reply: "Their message is the latest one, so the next move is yours. Longest waiting first.",
    no_reply: "You wrote and they have never answered, or you still have to reach out. Oldest first, so the stalest follow-up is at the top.",
    in_conversation: "Both of you have written and the next move is theirs, calls already scheduled included. Next action first.",
    closed: "Closed by you. Reopen puts someone back where the rules place them.",
    all: "Everyone, soonest next action first."
  };

  var state = {
    contacts: [],
    todos: [],
    other: [],
    otherMissing: false,
    questions: [],
    questionsMissing: false,
    questionsUpdated: null,
    contactsById: {},
    contactsUpdated: null,
    todosUpdated: null,
    otherUpdated: null,
    tab: "recruiting",
    peopleGroup: null,
    peopleStage: null,
    showLinked: false,
    live: false,
    expanded: {},
    laterOpen: {}
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

  // Their message is the latest and something is owed. A scheduled call
  // whose time is settled is not owed anything even when their acceptance
  // was the last message; one with a time still to confirm carries a draft.
  function owesReply(contact) {
    if (contact.last_touch_by !== "them" || contact.stage === "closed") return false;
    if (contact.stage === "call_scheduled" && !contact.draft_reply) return false;
    return true;
  }

  function isAwaitingMyReply(contact) {
    return owesReply(contact) && !isSnoozed(contact);
  }

  // Has this person ever written? first_reply is the agent's answer; until it
  // is backfilled, fall back on what the rest of the record implies.
  function everReplied(c) {
    // Once the agent has written first_reply (a date, or null for never),
    // that is the answer. The guesses below are only for records it has
    // not reached yet.
    if (Object.prototype.hasOwnProperty.call(c, "first_reply")) return !!c.first_reply || c.last_touch_by === "them";
    if (c.last_touch_by === "them") return true;
    if (c.stage === "response_received" || c.stage === "call_scheduled") return true;
    if (c.last_message && c.last_message.from === "them") return true;
    var history = Array.isArray(c.history) ? c.history : [];
    for (var i = 0; i < history.length; i++) {
      if (/^(they|she|he)\b|\b(replied|responded|wrote back)\b/i.test(history[i].event || "")) return true;
    }
    return false;
  }

  function groupOf(c) {
    if (c.stage === "closed") return "closed";
    if (owesReply(c)) return "needs_reply";
    return everReplied(c) ? "in_conversation" : "no_reply";
  }

  // Oldest last_touch first; people with no touch at all go last.
  function oldestTouchFirst(a, b) {
    var la = parseDate(a.last_touch), lb = parseDate(b.last_touch);
    if (la && lb && la.getTime() !== lb.getTime()) return la.getTime() - lb.getTime();
    if (la && !lb) return -1;
    if (!la && lb) return 1;
    return String(a.name || "").localeCompare(String(b.name || ""));
  }

  function groupSort(group) {
    return group === "no_reply" || group === "needs_reply" ? oldestTouchFirst : peopleSort;
  }

  // Date helpers for the Later presets: ISO date n days from today, and the
  // next Monday (a week ahead when today is Monday).
  function isoPlusDays(n) {
    var d = startOfToday();
    d.setDate(d.getDate() + n);
    return isoOf(d);
  }

  function isoNextMonday() {
    var d = startOfToday();
    var delta = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + delta);
    return isoOf(d);
  }

  function isoOf(d) {
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
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
      if (!res.ok) {
        var err = new Error(url + " returned HTTP " + res.status);
        err.status = res.status;
        throw err;
      }
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

  // The other-todos file is newer than the rest of the tracker and may not
  // exist yet; a missing file means an empty list, not a broken page.
  function optional(promise) {
    return promise.then(function (payload) { return payload; }, function (err) {
      if (err && (err.status === 404 || /HTTP 404/.test(err.message || ""))) return { missing: true, todos: [], questions: [] };
      throw err;
    });
  }

  function loadData() {
    if (github.token && github.repo) {
      return Promise.all([loadFromGithub(CONTACTS_URL), loadFromGithub(TODOS_URL), optional(loadFromGithub(OTHER_URL)), optional(loadFromGithub(QUESTIONS_URL))]).then(function (results) {
        return { results: results, live: true };
      }, function (err) {
        // Fall back to the published copy so a bad token never blanks the page.
        return Promise.all([loadJson(CONTACTS_URL), loadJson(TODOS_URL), optional(loadJson(OTHER_URL)), optional(loadJson(QUESTIONS_URL))]).then(function (results) {
          return { results: results, live: false, warning: err && err.message ? err.message : String(err) };
        });
      });
    }
    return Promise.all([loadJson(CONTACTS_URL), loadJson(TODOS_URL), optional(loadJson(OTHER_URL)), optional(loadJson(QUESTIONS_URL))]).then(function (results) {
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
    parts.push(plural(state.contacts.length, "contact") + ", " + plural(state.todos.length, "recruiting todo") + ", " + plural(state.other.length, "other todo"));
    var openQuestions = state.questions.filter(function (q) { return questionState(q) === "open"; }).length;
    if (openQuestions) parts.push(plural(openQuestions, "question") + " waiting");
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

  function todoHtml(t, kind) {
    var isOther = kind.name === "other";
    var contact = !isOther && t.contact_id ? state.contactsById[t.contact_id] : null;
    var due;
    if (t.status === "done") {
      due = { text: t.completed ? "done " + formatDate(t.completed) : "done", cls: "done" };
    } else {
      due = relativeDue(t.due, "due date");
    }
    var bits = [];
    bits.push('<span class="pill priority-' + escapeHtml(t.priority) + '">' + escapeHtml(t.priority) + "</span>");
    bits.push('<span class="due ' + due.cls + '">' + escapeHtml(due.text) + "</span>");
    if (isOther && t.category) bits.push('<span class="pill cat">' + escapeHtml(CATEGORY_LABELS[t.category] || t.category) + "</span>");
    if (isOther && t.sender) bits.push("<span>" + escapeHtml(t.sender) + "</span>");
    if (!isOther && t.company) bits.push("<span>" + escapeHtml(t.company) + "</span>");
    if (contact) bits.push("<span>" + escapeHtml(contact.name) + "</span>");
    if (t.source_thread_url) bits.push(link(t.source_thread_url, "Gmail thread"));
    if (t.source === "dashboard") bits.push('<span class="own-tag" title="Added by you on this page; the agent never changes it">mine</span>');
    var laterOpen = !!state.laterOpen[t.id];
    var action = t.status === "open"
      ? '<button type="button" class="btn btn-small btn-quiet" data-action="later" data-id="' + escapeHtml(t.id) + '" aria-expanded="' + laterOpen + '" title="Move the due date">Later</button>' +
        '<button type="button" class="btn btn-small" data-action="done" data-id="' + escapeHtml(t.id) + '">Mark done</button>'
      : '<button type="button" class="btn btn-small btn-quiet" data-action="open" data-id="' + escapeHtml(t.id) + '">Reopen</button>';
    var later = "";
    if (t.status === "open" && laterOpen) {
      later = '<form class="later-row" data-form="todo-due" data-id="' + escapeHtml(t.id) + '">' +
        '<span class="rewrite-label">Remind me</span>' +
        '<button type="button" class="chip" data-action="snooze" data-id="' + escapeHtml(t.id) + '" data-date="' + isoPlusDays(1) + '">Tomorrow</button>' +
        '<button type="button" class="chip" data-action="snooze" data-id="' + escapeHtml(t.id) + '" data-date="' + isoPlusDays(3) + '">In 3 days</button>' +
        '<button type="button" class="chip" data-action="snooze" data-id="' + escapeHtml(t.id) + '" data-date="' + isoNextMonday() + '">Next Monday</button>' +
        '<button type="button" class="chip" data-action="snooze" data-id="' + escapeHtml(t.id) + '" data-date="' + isoPlusDays(7) + '">In a week</button>' +
        '<label>or on <input type="date" name="due" value="' + escapeHtml(t.due || "") + '"></label>' +
        '<button type="submit" class="btn btn-small">Save date</button>' +
        "</form>";
    }
    return (
      '<li class="todo status-' + escapeHtml(t.status) + " priority-" + escapeHtml(t.priority) + (isSample(t) ? " sample" : "") + '" data-id="' + escapeHtml(t.id) + '">' +
      '<div class="todo-row">' +
      '<div class="todo-main">' +
      '<div class="todo-title">' + escapeHtml(t.title) + sampleTag(t) + "</div>" +
      '<div class="todo-meta">' + bits.join('<span class="sep">|</span>') + "</div>" +
      (t.notes ? '<div class="todo-notes">' + escapeHtml(t.notes) + "</div>" : "") +
      later +
      "</div>" +
      '<div class="todo-actions">' + action + "</div>" +
      "</div>" +
      "</li>"
    );
  }

  // A todo the agent linked to a person repeats that person's next action in
  // the People panel. Hidden here unless Show all is on. The owner's own
  // todos always show: nothing else on the page carries them.
  function isLinkedAgentTodo(t) {
    return !!t.contact_id && t.source !== "dashboard";
  }

  function renderTodos() {
    var status = el.todoStatus.value;
    var priority = el.todoPriority.value;
    var hidden = 0;
    var rows = state.todos.filter(function (t) {
      if (status !== "all" && t.status !== status) return false;
      if (priority !== "all" && t.priority !== priority) return false;
      if (!state.showLinked && isLinkedAgentTodo(t)) { hidden++; return false; }
      return true;
    }).sort(todoSort);
    el.todoShowLinked.checked = state.showLinked;
    el.todoCount.textContent = rows.length + " of " + state.todos.length;
    el.todoHiddenNote.hidden = hidden === 0;
    el.todoHiddenNote.textContent = plural(hidden, "todo") + " linked to people " + (hidden === 1 ? "is" : "are") + " hidden. They show as next actions in People. Switch on Show all to see them here.";
    el.todoList.innerHTML = rows.map(function (t) { return todoHtml(t, KINDS.recruiting); }).join("");
    el.todoEmpty.hidden = rows.length > 0;
  }

  // Due within the next 7 days, today included.
  function isDueThisWeek(t) {
    var n = daysFromToday(t.due);
    return n !== null && n >= 0 && n <= 7;
  }

  function isOverdue(t) {
    var n = daysFromToday(t.due);
    return n !== null && n < 0;
  }

  function renderOtherTiles() {
    var open = state.other.filter(function (t) { return t.status === "open"; });
    byId("tile-other-open").textContent = open.length;
    byId("tile-other-overdue").textContent = open.filter(isOverdue).length;
    byId("tile-other-week").textContent = open.filter(isDueThisWeek).length;
    byId("tile-other-high").textContent = open.filter(function (t) { return t.priority === "high"; }).length;
    el.otherOpenCount.textContent = open.length;
    el.otherOpenCount.hidden = open.length === 0;
  }

  function renderOtherCategoryOptions() {
    var inUse = {};
    state.other.forEach(function (t) { if (t.category) inUse[t.category] = true; });
    var all = OTHER_CATEGORIES.slice();
    Object.keys(inUse).forEach(function (c) { if (all.indexOf(c) === -1) all.push(c); });
    var current = el.otherCategory.value || "all";
    el.otherCategory.innerHTML = '<option value="all">All</option>' + all.map(function (c) {
      return '<option value="' + escapeHtml(c) + '">' + escapeHtml(CATEGORY_LABELS[c] || c) + "</option>";
    }).join("");
    el.otherCategory.value = all.indexOf(current) !== -1 || current === "all" ? current : "all";
    var chosen = el.addOtherCategory.value;
    el.addOtherCategory.innerHTML = OTHER_CATEGORIES.map(function (c) {
      return '<option value="' + escapeHtml(c) + '"' + (c === "other" && !chosen ? " selected" : "") + ">" + escapeHtml(CATEGORY_LABELS[c] || c) + "</option>";
    }).join("");
    if (chosen) el.addOtherCategory.value = chosen;
  }

  function renderOther() {
    var status = el.otherStatus.value;
    var priority = el.otherPriority.value;
    var category = el.otherCategory.value;
    var filter = state.otherFilter || null;
    var rows = state.other.filter(function (t) {
      if (status !== "all" && t.status !== status) return false;
      if (priority !== "all" && t.priority !== priority) return false;
      if (category !== "all" && t.category !== category) return false;
      if (filter === "overdue" && !isOverdue(t)) return false;
      if (filter === "week" && !isDueThisWeek(t)) return false;
      return true;
    }).sort(todoSort);
    el.otherCount.textContent = rows.length + " of " + state.other.length + (filter ? (filter === "overdue" ? ", overdue only" : ", due this week only") : "");
    el.otherList.innerHTML = rows.map(function (t) { return todoHtml(t, KINDS.other); }).join("");
    el.otherEmpty.hidden = rows.length > 0 || state.otherMissing;
    el.otherMissing.hidden = !state.otherMissing;
    renderOtherTiles();
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

  // Quick phrases the owner can drop into a rewrite request with one click.
  var REWRITE_CHIPS = [
    "Shorter.",
    "Less formal, more like how I actually write.",
    "More direct, lead with the ask.",
    "Propose two or three times for a call.",
    "Ask what the next steps and timeline are.",
    "Decline politely and keep the door open.",
    "Thank them and confirm the details they gave."
  ];

  // The draft block: the agent's current draft, if any, plus the owner's
  // rewrite request. The request is an owner-only field; the agent reads it
  // on its next run, re-reads the whole thread, rewrites the draft and clears
  // the request. The page never calls a model itself.
  function draftHtml(c) {
    var req = c.draft_request && c.draft_request.instructions ? c.draft_request : null;
    var html = '<div class="details-block details-draft">' +
      '<div class="details-title">Draft reply' +
      '<span class="details-actions">' +
      (c.draft_reply ? '<button type="button" class="btn btn-small" data-action="copy-draft" data-id="' + escapeHtml(c.id) + '">Copy</button>' : "") +
      (c.thread_url ? link(c.thread_url, "Open thread") : "") +
      "</span></div>";
    if (c.draft_reply) {
      html += '<pre class="details-text">' + escapeHtml(c.draft_reply) + "</pre>" +
        '<div class="details-note">Nothing is sent from here. Copy it, paste it into Gmail, adjust, send.</div>';
    } else {
      html += '<div class="details-note">No draft yet. Ask for one below and the agent writes it on its next run.</div>';
    }
    if (req) {
      html += '<div class="request-state" data-id="' + escapeHtml(c.id) + '">' +
        '<div class="request-state-title">Rewrite requested ' + escapeHtml(formatDate(req.date)) +
        '<button type="button" class="btn btn-small btn-quiet" data-action="withdraw-rewrite" data-id="' + escapeHtml(c.id) + '">Withdraw</button></div>' +
        '<pre class="details-text request-text">' + escapeHtml(req.instructions) + "</pre>" +
        '<div class="details-note">The agent rewrites the draft on its next run using the whole thread, your notes and these instructions, then clears this request.</div>' +
        "</div>";
    } else {
      var chips = REWRITE_CHIPS.map(function (text) {
        return '<button type="button" class="chip" data-action="rewrite-chip" data-text="' + escapeHtml(text) + '">' + escapeHtml(text.replace(/\.$/, "")) + "</button>";
      }).join("");
      html += '<form class="note-form rewrite-form" data-form="rewrite" data-id="' + escapeHtml(c.id) + '">' +
        '<div class="rewrite-label">' + (c.draft_reply ? "Not right? Tell the agent what to change." : "What should the reply do?") + "</div>" +
        '<div class="chips">' + chips + "</div>" +
        '<textarea name="instructions" rows="3" maxlength="2000" placeholder="Anything the thread does not say: what you want from this person, what you already agreed on a call, the tone, what to leave out. The agent reads the whole email thread plus this."></textarea>' +
        '<button type="submit" class="btn btn-small">' + (c.draft_reply ? "Request rewrite" : "Request a draft") + "</button>" +
        "</form>";
    }
    return html + "</div>";
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
    blocks.push(draftHtml(c));
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
      ? '<button type="button" class="btn btn-small btn-quiet details-toggle" data-action="toggle-details" data-id="' + escapeHtml(c.id) + '" aria-expanded="' + expanded + '">' + (expanded ? "Hide" : "Details") + (c.draft_request && !expanded ? '<span class="draft-dot request-dot" title="Rewrite requested"></span>' : (c.draft_reply && !expanded ? '<span class="draft-dot" title="Draft reply ready"></span>' : "")) + "</button>"
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
    var counts = { needs_reply: 0, no_reply: 0, in_conversation: 0, closed: 0, all: state.contacts.length };
    state.contacts.forEach(function (c) { counts[groupOf(c)]++; });
    if (!state.peopleGroup) {
      // First render: open the group that has something to do in it.
      state.peopleGroup = counts.needs_reply ? "needs_reply" : counts.no_reply ? "no_reply" : counts.in_conversation ? "in_conversation" : "needs_reply";
    }
    var group = state.peopleGroup;
    var stageFilter = state.peopleStage;
    el.peopleSegments.forEach(function (seg) {
      var name = seg.getAttribute("data-group");
      seg.setAttribute("aria-selected", String(name === group));
      var count = seg.querySelector(".seg-count");
      if (count) count.textContent = counts[name];
    });
    el.peopleGroupNote.textContent = GROUP_NOTES[group] || "";
    el.peopleStageChip.hidden = !stageFilter;
    if (stageFilter) el.peopleStageChip.textContent = "Stage: " + (STAGE_LABELS[stageFilter] || stageFilter) + "  \u00d7";
    var q = el.peopleSearch.value.trim().toLowerCase();
    var rows = state.contacts.filter(function (c) {
      if (group !== "all" && groupOf(c) !== group) return false;
      if (stageFilter && c.stage !== stageFilter) return false;
      if (q) {
        var hay = [c.name, c.email, c.company, c.role, c.next_action, c.notes, c.source, STAGE_LABELS[c.stage]]
          .join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).sort(groupSort(group));
    el.peopleCount.textContent = rows.length + " of " + state.contacts.length;
    el.peopleBody.innerHTML = rows.map(personHtml).join("");
    el.peopleEmpty.hidden = rows.length > 0;
  }

  function setShowLinked(on) {
    state.showLinked = !!on;
    storageSet(KEY_SHOW_LINKED, state.showLinked ? "1" : null);
    renderTodos();
  }

  function setPeopleGroup(group, stageFilter) {
    state.peopleGroup = GROUPS.indexOf(group) === -1 ? "all" : group;
    state.peopleStage = stageFilter || null;
    renderPeople();
  }

  function render() {
    renderMeta();
    renderTiles();
    renderTodos();
    renderTodoContactOptions();
    renderOtherCategoryOptions();
    renderOther();
    renderAsk();
    renderPeople();
  }

  // ------------------------------------------------------------------
  // Ask me: the agent's open questions, answered here, acted on next run
  // ------------------------------------------------------------------

  function questionState(q) {
    if (q.status === "resolved") return "resolved";
    return q.answer ? "answered" : "open";
  }

  function questionHtml(q) {
    var st = questionState(q);
    var head = [];
    if (q.company) head.push("<span>" + escapeHtml(q.company) + "</span>");
    head.push("<span>asked " + escapeHtml(formatDate(q.asked_on)) + "</span>");
    if (q.kind && QUESTION_KIND_LABELS[q.kind]) head.push("<span>" + escapeHtml(QUESTION_KIND_LABELS[q.kind]) + "</span>");
    if (q.thread_url) head.push(link(q.thread_url, "Gmail thread"));
    var body;
    if (st === "resolved") {
      body = '<div class="q-answer">Resolved ' + escapeHtml(formatDate(q.resolved_on)) + (q.answer ? ", you said: " + escapeHtml(ANSWER_LABELS[q.answer] || q.answer) : "") + (q.result ? ". " + escapeHtml(q.result) : "") + "</div>";
    } else if (st === "answered") {
      body = '<div class="q-answer">You answered: ' + escapeHtml(ANSWER_LABELS[q.answer] || q.answer) + " on " + escapeHtml(formatDate(q.answered_on)) + ". The agent acts on its next run." +
        '<button type="button" class="btn btn-small btn-quiet" data-action="unanswer" data-id="' + escapeHtml(q.id) + '">Change</button></div>';
    } else {
      body = '<div class="q-actions">' +
        '<button type="button" class="btn btn-small btn-primary" data-action="answer" data-answer="track" data-id="' + escapeHtml(q.id) + '">Track as recruiting</button>' +
        '<button type="button" class="btn btn-small" data-action="answer" data-answer="skip" data-id="' + escapeHtml(q.id) + '">Not recruiting</button>' +
        '<button type="button" class="btn btn-small btn-quiet" data-action="answer" data-answer="other_todo" data-id="' + escapeHtml(q.id) + '">Make it an Other todo</button>' +
        "</div>";
    }
    return '<li class="todo question ' + st + '" data-id="' + escapeHtml(q.id) + '">' +
      '<div class="todo-main">' +
      '<div class="todo-title">' + escapeHtml(q.sender || "Unknown sender") + (q.subject ? ': <span class="muted">' + escapeHtml(q.subject) + "</span>" : "") + "</div>" +
      '<div class="todo-meta">' + head.join('<span class="sep">|</span>') + "</div>" +
      (q.why ? '<div class="q-why">' + escapeHtml(q.why) + "</div>" : "") +
      body +
      "</div></li>";
  }

  function renderAsk() {
    var want = el.askStatus.value;
    var open = state.questions.filter(function (q) { return questionState(q) === "open"; });
    el.askOpenCount.textContent = open.length;
    el.askOpenCount.hidden = open.length === 0;
    var rows = state.questions.filter(function (q) { return want === "all" || questionState(q) === want; });
    rows.sort(function (a, b) { return String(b.asked_on || "").localeCompare(String(a.asked_on || "")) || String(b.id).localeCompare(String(a.id)); });
    el.askCount.textContent = rows.length + " of " + state.questions.length;
    el.askList.innerHTML = rows.map(questionHtml).join("");
    el.askEmpty.hidden = rows.length > 0 || state.questionsMissing;
    el.askMissing.hidden = !state.questionsMissing;
  }

  function answerQuestion(id, answer, button) {
    if (!requireToken(function () { answerQuestion(id, answer, null); })) return;
    setBusy(button, true);
    var message = "update: " + id + (answer ? " answered " + answer : " answer cleared") + " (dashboard)";
    saveRecord(QUESTIONS_URL, "questions", id, function (q, today) {
      q.answer = answer || null;
      q.answered_on = answer ? today : null;
    }, message).then(function (saved) {
      var local = findTodo(state.questions, id);
      if (local) { local.answer = saved.answer; local.answered_on = saved.answered_on; local.updated_at = saved.updated_at; }
      state.questionsUpdated = saved.updated_at;
      state.live = true;
      render();
      toast(answer ? "Saved. The agent acts on this on its next run." : "Answer cleared.");
    }).catch(function (err) {
      setBusy(button, false);
      toast(err && err.message ? err.message : String(err), true);
    });
  }

  function onAskClick(event) {
    var button = event.target.closest ? event.target.closest("button[data-action]") : null;
    if (!button || button.disabled) return;
    var id = button.getAttribute("data-id");
    if (button.getAttribute("data-action") === "answer") answerQuestion(id, button.getAttribute("data-answer"), button);
    else if (button.getAttribute("data-action") === "unanswer") answerQuestion(id, "", button);
  }

  // ------------------------------------------------------------------
  // Tabs
  // ------------------------------------------------------------------

  function setTab(name, pushHash) {
    if (TABS.indexOf(name) === -1) name = "recruiting";
    state.tab = name;
    el.tabs.forEach(function (tab) {
      var active = tab.getAttribute("data-tab") === name;
      tab.setAttribute("aria-selected", String(active));
    });
    el.viewRecruiting.hidden = name !== "recruiting";
    el.viewOther.hidden = name !== "other";
    el.viewAsk.hidden = name !== "ask";
    if (pushHash !== false) {
      var hash = name === "recruiting" ? "" : "#" + name;
      if (window.location.hash !== hash) {
        try { history.replaceState(null, "", window.location.pathname + window.location.search + hash); } catch (e) { /* ignore */ }
      }
    }
  }

  function tabFromHash() {
    var name = window.location.hash.replace(/^#/, "");
    return TABS.indexOf(name) === -1 ? "recruiting" : name;
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
  // empty result means nothing is written. message is the commit message, or
  // a function of (changed, today) when it needs an id chosen during the
  // write. Retries once when the file changed under us (409 or 422).
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
          message: typeof message === "function" ? message(changed, today) : message,
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
    ["stage", "next_action", "next_action_date", "draft_reply", "draft_request", "history", "respond_on", "owner_notes", "first_reply", "updated_at"].forEach(function (key) {
      if (key in saved) local[key] = saved[key];
    });
  }

  // A follow-up or reply todo marked done means the owner sent it. The same
  // rule the agent follows in chat ("mark the Google follow-up done"): the
  // contact's last touch becomes today by me, the stage follows, the draft
  // is cleared, and a history line records it.
  var SENT_TITLE_RE = /^(follow up|follow-up|reply|respond|send (a )?(follow|reply|thank))/i;

  function markSentOnContact(todo, today) {
    var contactId = todo.contact_id;
    if (!contactId || !SENT_TITLE_RE.test(todo.title || "")) return Promise.resolve(null);
    var isFollowUp = /^follow/i.test(todo.title || "");
    return saveRecord(CONTACTS_URL, "contacts", contactId, function (contact) {
      if (contact.stage === "closed") return;
      contact.last_touch = today;
      contact.last_touch_by = "me";
      if (contact.stage !== "call_scheduled") contact.stage = "emailed";
      contact.draft_reply = null;
      var first = String(contact.name || "").split(" ")[0];
      contact.next_action = "Wait for " + (first || "them") + " to reply, follow up again after " + formatDate(isoPlusDays(4));
      contact.next_action_date = isoPlusDays(4);
      if (!Array.isArray(contact.history)) contact.history = [];
      contact.history.push({ date: today, event: (isFollowUp ? "Sent follow-up" : "Sent reply") + " (" + todo.id + " marked done on the dashboard)" });
      if (contact.respond_on) {
        contact.respond_on = null;
        contact.history.push({ date: today, event: "Owner replied, planned respond date cleared" });
      }
    }, "update: " + contactId + (isFollowUp ? " follow-up sent" : " reply sent") + " (dashboard)").then(function (saved) {
      if (saved && saved.stage !== "closed") {
        var local = state.contactsById[contactId];
        if (local) {
          ["last_touch", "last_touch_by", "stage", "draft_reply", "next_action", "next_action_date", "history", "respond_on", "updated_at"].forEach(function (k) { local[k] = saved[k]; });
        }
        state.contactsUpdated = saved.updated_at;
      }
      return saved;
    });
  }

  function setTodoStatus(kind, id, status, button) {
    if (!requireToken(function () { setTodoStatus(kind, id, status, null); })) return;
    setBusy(button, true);
    var savedTodo = null;
    saveRecord(kind.url, "todos", id, function (todo, today) {
      todo.status = status;
      todo.completed = status === "done" ? today : null;
    }, "update: " + id + (status === "done" ? " done" : " reopened") + " (dashboard)").then(function (saved) {
      savedTodo = saved;
      var local = findTodo(state[kind.stateKey], id);
      if (local) {
        local.status = saved.status;
        local.completed = saved.completed;
        local.updated_at = saved.updated_at;
      }
      state[kind.updatedKey] = saved.updated_at;
      state.live = true;
      if (kind.name === "recruiting" && status === "done") return markSentOnContact(saved, todayIso());
      return null;
    }).then(function (contact) {
      render();
      toast("Saved " + id + " to GitHub." + (contact ? " " + (contact.name || "The person") + " now shows as written to today." : ""));
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
      if (!closing) return [];
      // A closed person's open todos go with them, so nothing dangles.
      return saveFile(TODOS_URL, "todos", function (list, today) {
        return list.filter(function (t) { return t.contact_id === id && t.status === "open"; })
          .map(function (t) { t.status = "done"; t.completed = today; t.notes = ((t.notes || "") + " Closed with the contact on the dashboard.").trim(); return t; });
      }, "update: todos for " + id + " done with close (dashboard)");
    }).then(function (changedTodos) {
      (changedTodos || []).forEach(function (t) {
        var local = findTodo(state.todos, t.id);
        if (local) { local.status = t.status; local.completed = t.completed; local.notes = t.notes; local.updated_at = t.updated_at; }
      });
      render();
      toast((closing ? "Closed " : "Reopened ") + id + " and saved to GitHub." + (changedTodos && changedTodos.length ? " " + plural(changedTodos.length, "open todo") + " marked done with it." : ""));
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

  // Owner-only rewrite request for the draft reply. The agent fulfils it on
  // its next run and sets the field back to null.
  function setDraftRequest(id, instructions, button) {
    if (!requireToken(function () { setDraftRequest(id, instructions, null); })) return;
    setBusy(button, true);
    var withdrawing = !instructions;
    var message = "update: " + id + (withdrawing ? " draft rewrite withdrawn" : " draft rewrite requested") + " (dashboard)";
    saveRecord(CONTACTS_URL, "contacts", id, function (contact, today) {
      contact.draft_request = withdrawing ? null : { date: today, instructions: instructions };
    }, message).then(function (saved) {
      copyContactFields(id, saved);
      state.contactsUpdated = saved.updated_at;
      state.live = true;
      render();
      toast(withdrawing ? "Rewrite request withdrawn." : "Saved. The agent rewrites this draft on its next run.");
    }).catch(function (err) {
      setBusy(button, false);
      toast(err && err.message ? err.message : String(err), true);
    });
  }

  // Move a todo's due date: the "remind me later" action. Works on any open
  // todo in either list, the owner's own or the agent's.
  function setTodoDue(kind, id, dateStr, button) {
    if (!requireToken(function () { setTodoDue(kind, id, dateStr, null); })) return;
    setBusy(button, true);
    saveRecord(kind.url, "todos", id, function (todo) {
      todo.due = dateStr;
    }, "update: " + id + " due " + dateStr + " (dashboard)").then(function (saved) {
      var local = findTodo(state[kind.stateKey], id);
      if (local) { local.due = saved.due; local.updated_at = saved.updated_at; }
      state[kind.updatedKey] = saved.updated_at;
      state.live = true;
      delete state.laterOpen[id];
      render();
      toast("Moved " + id + " to " + formatDate(dateStr) + ".");
    }).catch(function (err) {
      setBusy(button, false);
      toast(err && err.message ? err.message : String(err), true);
    });
  }

  // Ids follow the schema in CLAUDE.md: the list's prefix plus four digits,
  // max existing plus one, never reused.
  function newTodoId(list, prefix) {
    var max = 0;
    var re = new RegExp("^" + prefix + "(\\d{4})$");
    list.forEach(function (t) {
      var m = re.exec(String(t.id || ""));
      if (m && parseInt(m[1], 10) > max) max = parseInt(m[1], 10);
    });
    var next = String(max + 1);
    while (next.length < 4) next = "0" + next;
    return prefix + next;
  }

  // A todo the owner types in, not derived from mail. Marked source
  // "dashboard" so the agent leaves it alone.
  function addTodo(kind, fields, form, button) {
    if (!requireToken(function () { addTodo(kind, fields, form, null); })) return;
    setBusy(button, true);
    var contact = kind.name === "recruiting" && fields.contact_id ? state.contactsById[fields.contact_id] : null;
    var created = null;
    saveFile(kind.url, "todos", function (list, today) {
      created = kind.name === "other"
        ? {
          id: newTodoId(list, kind.prefix),
          title: fields.title,
          priority: fields.priority,
          status: "open",
          due: fields.due || null,
          sender: null,
          category: fields.category || "other",
          source: "dashboard",
          source_thread_url: null,
          created: today,
          completed: null,
          notes: fields.notes || null,
          updated_at: today
        }
        : {
          id: newTodoId(list, kind.prefix),
          title: fields.title,
          priority: fields.priority,
          status: "open",
          due: fields.due || null,
          contact_id: contact ? contact.id : null,
          company: contact && contact.company ? contact.company : null,
          source_thread_url: contact && contact.thread_url ? contact.thread_url : null,
          created: today,
          completed: null,
          notes: fields.notes || null,
          source: "dashboard",
          updated_at: today
        };
      list.push(created);
      return [created];
    }, function (changed) { return "update: " + changed[0].id + " added (dashboard)"; }).then(function (changed) {
      var saved = changed[0] || created;
      state[kind.stateKey].push(saved);
      state[kind.updatedKey] = saved.updated_at;
      state.live = true;
      form.reset();
      form.hidden = true;
      var toggle = document.querySelector('[data-action="toggle-add"][aria-controls="' + form.id + '"]');
      if (toggle) toggle.setAttribute("aria-expanded", "false");
      setBusy(button, false);
      render();
      toast("Added " + saved.id + " and saved to GitHub.");
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
    if (tile.indexOf("other-") === 0) {
      el.otherStatus.value = "open";
      el.otherPriority.value = tile === "other-high" ? "high" : "all";
      state.otherFilter = tile === "other-overdue" ? "overdue" : tile === "other-week" ? "week" : null;
      renderOther();
      byId("other-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (tile === "open") {
      el.todoStatus.value = "open";
      el.todoPriority.value = "all";
      setShowLinked(true);
      byId("todos-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (tile === "high") {
      el.todoStatus.value = "open";
      el.todoPriority.value = "high";
      setShowLinked(true);
      byId("todos-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (tile === "follow") {
      setPeopleGroup("all", "follow_up_needed");
      byId("people-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (tile === "awaiting") {
      setPeopleGroup("needs_reply", null);
      byId("people-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function kindOfList(list) {
    return KINDS[list.getAttribute("data-kind")] || KINDS.recruiting;
  }

  function onTodoListClick(event) {
    var button = event.target.closest ? event.target.closest("button[data-action]") : null;
    if (!button || button.disabled) return;
    var kind = kindOfList(event.currentTarget);
    var id = button.getAttribute("data-id");
    var action = button.getAttribute("data-action");
    if (action === "later") {
      if (state.laterOpen[id]) delete state.laterOpen[id];
      else state.laterOpen[id] = true;
      if (kind.name === "other") renderOther(); else renderTodos();
      var input = event.currentTarget.querySelector('form[data-form="todo-due"][data-id="' + id + '"] input[name="due"]');
      if (input) input.focus();
    } else if (action === "snooze") {
      setTodoDue(kind, id, button.getAttribute("data-date"), button);
    } else {
      setTodoStatus(kind, id, action === "done" ? "done" : "open", button);
    }
  }

  function onTodoListSubmit(event) {
    var form = event.target;
    if (!form || form.getAttribute("data-form") !== "todo-due") return;
    event.preventDefault();
    var dateStr = form.querySelector('input[name="due"]').value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { toast("Pick a date first.", true); return; }
    setTodoDue(kindOfList(event.currentTarget), form.getAttribute("data-id"), dateStr, form.querySelector('button[type="submit"]'));
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
    } else if (action === "withdraw-rewrite") {
      setDraftRequest(id, "", button);
    } else if (action === "rewrite-chip") {
      var form = button.closest("form");
      var area = form ? form.querySelector("textarea") : null;
      if (!area) return;
      var text = button.getAttribute("data-text") || "";
      area.value = (area.value.trim() ? area.value.replace(/\s+$/, "") + " " : "") + text;
      area.focus();
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
    } else if (kind === "rewrite") {
      var instructions = form.querySelector('textarea[name="instructions"]').value.trim();
      if (!instructions) { toast("Say what you want changed first.", true); return; }
      setDraftRequest(id, instructions, button);
    }
  }

  // Add-todo forms: one per tab, told apart by data-kind. The toggle button
  // names its form in aria-controls; Cancel sits inside the form.
  function onAddControls(event) {
    var button = event.target.closest ? event.target.closest('button[data-action="toggle-add"], button[data-action="cancel-add"]') : null;
    if (!button) return;
    var form = button.getAttribute("data-action") === "toggle-add"
      ? byId(button.getAttribute("aria-controls"))
      : button.closest("form");
    if (!form) return;
    var toggle = document.querySelector('[data-action="toggle-add"][aria-controls="' + form.id + '"]');
    var open = form.hidden;
    if (button.getAttribute("data-action") === "cancel-add") { form.reset(); open = false; }
    form.hidden = !open;
    if (toggle) toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      var first = form.querySelector('input[name="title"]');
      if (first) first.focus();
    }
  }

  function onAddSubmit(event) {
    var form = event.target;
    if (!form || !form.classList.contains("add-todo-form")) return;
    event.preventDefault();
    var kind = KINDS[form.getAttribute("data-kind")] || KINDS.recruiting;
    var f = form.elements;
    var title = (f.title.value || "").trim();
    if (!title) { toast("Give the todo a title first.", true); return; }
    var due = (f.due.value || "").trim();
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) { toast("The due date does not look right.", true); return; }
    if (kind.name === "other" && state.otherMissing) {
      toast("The data repo has no data/other_todos.json yet, so there is nowhere to save this. Pull the latest tooling first.", true);
      return;
    }
    addTodo(kind, {
      title: title,
      priority: f.priority.value || "medium",
      due: due,
      contact_id: f.contact_id ? f.contact_id.value : "",
      category: f.category ? f.category.value : "",
      notes: (f.notes.value || "").trim()
    }, form, form.querySelector('button[type="submit"]'));
  }

  // The person dropdown on the add-todo form: active people first, then
  // closed ones, so a todo can still hang off someone who has been closed.
  function renderTodoContactOptions() {
    var current = el.addTodoContact.value;
    var people = state.contacts.slice().sort(function (a, b) {
      var ca = a.stage === "closed" ? 1 : 0, cb = b.stage === "closed" ? 1 : 0;
      if (ca !== cb) return ca - cb;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
    var html = '<option value="">No one in particular</option>' + people.map(function (c) {
      var label = c.name + (c.company ? ", " + c.company : "") + (c.stage === "closed" ? " (closed)" : "");
      return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(label) + "</option>";
    }).join("");
    el.addTodoContact.innerHTML = html;
    el.addTodoContact.value = current;
  }

  function bind() {
    el.todoStatus.addEventListener("change", renderTodos);
    el.todoShowLinked.addEventListener("change", function () { setShowLinked(el.todoShowLinked.checked); });
    el.todoPriority.addEventListener("change", renderTodos);
    el.peopleSegments.forEach(function (seg) {
      seg.addEventListener("click", function () { setPeopleGroup(seg.getAttribute("data-group"), null); });
    });
    el.peopleStageChip.addEventListener("click", function () { setPeopleGroup(state.peopleGroup, null); });
    el.peopleSearch.addEventListener("input", renderPeople);
    el.todoList.addEventListener("click", onTodoListClick);
    el.todoList.addEventListener("submit", onTodoListSubmit);
    el.otherList.addEventListener("click", onTodoListClick);
    el.otherList.addEventListener("submit", onTodoListSubmit);
    el.otherStatus.addEventListener("change", function () { state.otherFilter = null; renderOther(); });
    el.otherPriority.addEventListener("change", function () { state.otherFilter = null; renderOther(); });
    el.otherCategory.addEventListener("change", function () { state.otherFilter = null; renderOther(); });
    el.askStatus.addEventListener("change", renderAsk);
    el.askList.addEventListener("click", onAskClick);
    el.tabs.forEach(function (tab) {
      tab.addEventListener("click", function () { setTab(tab.getAttribute("data-tab")); });
    });
    window.addEventListener("hashchange", function () { setTab(tabFromHash(), false); });
    el.peopleBody.addEventListener("click", onPeopleClick);
    el.peopleBody.addEventListener("submit", onPeopleSubmit);
    el.githubConnect.addEventListener("click", function () { openGithubDialog(""); });
    el.githubForm.addEventListener("submit", onGithubSave);
    el.githubCancel.addEventListener("click", function () { pendingAction = null; closeGithubDialog(); });
    el.githubDisconnect.addEventListener("click", onGithubDisconnect);
    document.addEventListener("click", onAddControls);
    el.addTodoForm.addEventListener("submit", onAddSubmit);
    el.addOtherForm.addEventListener("submit", onAddSubmit);
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
    el.todoShowLinked = byId("todo-show-linked");
    el.todoHiddenNote = byId("todo-hidden-note");
    state.showLinked = storageGet(KEY_SHOW_LINKED) === "1";
    el.peopleSegments = Array.prototype.slice.call(document.querySelectorAll("#people-groups .seg[data-group]"));
    el.peopleGroupNote = byId("people-group-note");
    el.peopleStageChip = byId("people-stage-chip");
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
    el.addTodoForm = byId("add-todo-form");
    el.addTodoContact = byId("add-todo-contact");
    el.addOtherForm = byId("add-other-form");
    el.addOtherCategory = byId("add-other-category");
    el.otherList = byId("other-list");
    el.otherEmpty = byId("other-empty");
    el.otherMissing = byId("other-missing");
    el.otherCount = byId("other-count");
    el.otherStatus = byId("other-status");
    el.otherPriority = byId("other-priority");
    el.otherCategory = byId("other-category");
    el.otherOpenCount = byId("other-open-count");
    el.viewRecruiting = byId("view-recruiting");
    el.viewOther = byId("view-other");
    el.viewAsk = byId("view-ask");
    el.askList = byId("ask-list");
    el.askEmpty = byId("ask-empty");
    el.askMissing = byId("ask-missing");
    el.askCount = byId("ask-count");
    el.askStatus = byId("ask-status");
    el.askOpenCount = byId("ask-open-count");
    el.tabs = Array.prototype.slice.call(document.querySelectorAll(".tab[data-tab]"));
    loadGithubSettings();
    setTab(tabFromHash(), false);
    renderGithubState();
    bind();
    loadAndRender();
  }

  function loadAndRender() {
    loadData()
      .then(function (loaded) {
        var contacts = unwrap(loaded.results[0], "contacts");
        var todos = unwrap(loaded.results[1], "todos");
        var other = unwrap(loaded.results[2], "todos");
        var questions = unwrap(loaded.results[3], "questions");
        state.questions = questions.rows;
        state.questionsMissing = !!(loaded.results[3] && loaded.results[3].missing);
        state.questionsUpdated = questions.updated;
        state.contacts = contacts.rows;
        state.todos = todos.rows;
        state.other = other.rows;
        state.otherMissing = !!(loaded.results[2] && loaded.results[2].missing);
        state.contactsUpdated = contacts.updated;
        state.todosUpdated = todos.updated;
        state.otherUpdated = other.updated;
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
