const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { setTimeout: wait } = require("node:timers/promises");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { fetchGroups, viewFor } = require("../extension/estimates.js");

const origin = "https://bandlab.atlassian.net";
const list = new URL("/jira/software/c/projects/IOS/list", origin);
const jql = "project = IOS AND assignee = currentUser() AND status != Closed";
list.search = new URLSearchParams({ jql, groupBy: "customfield_10006" });

const sprint = (name, state) => ({ name, state });
const issue = (number, points, sprints) => ({
  key: "IOS-" + number,
  fields: { customfield_10900: points, customfield_10006: sprints }
});
const old = sprint("Old sprint", "closed");
const current = sprint("Sprint 12", "active");
const upcoming = sprint("Sprint 13", "future");

const heading = (name, count, open) => `
  <tr><td colspan="4">
    <button aria-label="${open ? "Collapse" : "Expand"} group"></button>
    <span class="group-name">${name}</span><span class="count">${count}</span>
    <button aria-label="Create work item">+</button>
  </td></tr>`;
const row = (number, points) => `
  <tr><td></td><th><a href="/browse/IOS-${number}">IOS-${number}</a> Summary</th>
      <td><button aria-label="Edit Story Points${points === "None" ? "" : ", " + points}">${points}</button></td>
      <td>Open</td></tr>`;

function browser(t, html, fetch, url = list) {
  const { window } = new JSDOM(`
    <!doctype html><html lang="en"><body><input placeholder="Search work">
    <table aria-label="Work">
      <thead><tr><th></th><th>Work</th><th><button>Story Points • Sort lowest to highest</button></th><th>Status</th></tr></thead>
      <tbody>${html}</tbody>
    </table></body></html>`,
  { url: url.href, runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => window.close());
  window.fetch = fetch;
  for (const file of ["estimates.js", "list.js"]) {
    window.eval(readFileSync(new URL("../extension/" + file, "file://" + __filename), "utf8"));
  }
  const badges = () => [...window.document.querySelectorAll("[data-jira-sprint-estimates]")].map(
    (element) => element.dataset.text
  );
  return { window, badges };
}

async function until(check) {
  for (let step = 0; step < 50; step++) {
    if (check()) return;
    await wait(20);
  }
  assert.fail("Timed out waiting for the extension to update");
}

test("uses every Jira search page and groups current, completed, and backlog issues once", async () => {
  const requests = [];
  const groups = await fetchGroups(jql, origin, async (url, options) => {
    requests.push(url);
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, "/rest/api/3/search/jql");
    assert.equal(url.searchParams.get("jql"), jql);
    assert.equal(url.searchParams.get("fields"), "customfield_10006,customfield_10900");
    assert.equal(options.method, undefined);
    assert.equal(options.credentials, "same-origin");
    const page = requests.length === 1
      ? { issues: [issue(1, 1.5, [old, current]), issue(2, null, [old])], isLast: false, nextPageToken: "more" }
      : { issues: [issue(1, 1.5, [old, current]), issue(3, 0, null)], isLast: true };
    return { ok: true, json: async () => page };
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].searchParams.get("nextPageToken"), "more");
  assert.deepEqual([...groups], [
    ["sprint:Sprint 12", new Map([["IOS-1", 1.5]])],
    ["completed", new Map([["IOS-2", null]])],
    ["backlog", new Map([["IOS-3", 0]])]
  ]);
});

test("rejects an incomplete Jira search instead of reporting a partial total", async () => {
  await assert.rejects(fetchGroups(jql, origin, async () => ({
    ok: true,
    json: async () => ({ issues: [issue(1, 1.5, [current])], isLast: false })
  })), /incomplete/);
});

test("adds estimates to expanded and collapsed sprint headers and responds to edits", async (t) => {
  const { window, badges } = browser(t,
    heading("Sprint 12", 3, true) + row(1, "1.5") + row(2, "0") + row(3, "None") +
    heading("Sprint 13", 2, false) + heading("Completed sprint", 1, false) + heading("Backlog", 1, false),
    async () => ({
      ok: true,
      json: async () => ({ isLast: true, issues: [
        issue(1, 1.5, [current]), issue(2, 0, [current]), issue(3, null, [current]),
        issue(4, 0.25, [old, upcoming]), issue(5, 0.5, [upcoming]),
        issue(6, null, [old]), issue(7, 1, null)
      ] })
    }));
  await until(() => badges().at(-1)?.endsWith("SP 1"));
  assert.deepEqual(badges(), [
    "Estimated 2 · Unestimated 1 · SP 1.5",
    "Estimated 2 · Unestimated 0 · SP 0.75",
    "Estimated 0 · Unestimated 1 · SP 0",
    "Estimated 1 · Unestimated 0 · SP 1"
  ]);
  assert.equal(window.document.querySelector(".count").nextElementSibling.dataset.text, badges()[0]);
  window.document.querySelector('button[aria-label="Edit Story Points"]').textContent = "0.25";
  await until(() => badges()[0] === "Estimated 3 · Unestimated 0 · SP 1.75");

  const otherGrouping = new URL(list);
  otherGrouping.searchParams.set("groupBy", "status");
  window.history.pushState({}, "", otherGrouping.href);
  window.dispatchEvent(new window.PopStateEvent("popstate"));
  await until(() => badges().length === 0);
});

test("withholds totals when a virtualized group disagrees with the Jira search", async (t) => {
  const { badges } = browser(t,
    heading("Sprint 12", 2, true) + row(1, "1.5") + heading("Sprint 13", 2, false),
    async () => ({
      ok: true,
      json: async () => ({ isLast: true, issues: [
        issue(2, 1.5, [current]), issue(3, 1, [current]), issue(4, null, [upcoming])
      ] })
    }));
  await until(() => badges()[0] === "Estimates unavailable for the full group");
  assert.equal(badges()[1], "Expand this group to see estimates");
});

test("ignores stale search results after changing the visible JQL without reloading", async (t) => {
  let respond;
  const delayed = new Promise((resolve) => { respond = resolve; });
  const { window, badges } = browser(t, heading("Sprint 12", 1, false), async (url) => {
    if (url.searchParams.get("jql") === jql) return delayed;
    return { ok: true, json: async () => ({ isLast: true, issues: [issue(2, 0.25, [current])] }) };
  });
  await until(() => badges()[0] === "Loading estimates…");
  const filtered = new URL(list);
  filtered.searchParams.set("jql", jql + " AND priority = Normal");
  window.history.pushState({}, "", filtered.href);
  window.dispatchEvent(new window.PopStateEvent("popstate"));
  await until(() => badges()[0] === "Estimated 1 · Unestimated 0 · SP 0.25");
  respond({ ok: true, json: async () => ({ isLast: true, issues: [issue(1, 10, [current])] }) });
  await wait(120);
  assert.equal(badges()[0], "Estimated 1 · Unestimated 0 · SP 0.25");
});

test("only applies to the iOS project list when grouped by Sprint", () => {
  assert.equal(viewFor(list).jql, jql);
  for (const path of ["/jira/software/c/projects/QA/list", "/jira/software/c/projects/IOS/boards/90/backlog"]) {
    assert.equal(viewFor(new URL(path + list.search, origin)), null);
  }
});
