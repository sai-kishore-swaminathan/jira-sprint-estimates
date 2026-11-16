(() => {
  "use strict";

  const sprintField = "customfield_10006";
  const pointsField = "customfield_10900";
  const normalize = (text) => text.replace(/\s+/g, " ").trim();

  function viewFor(url) {
    if (!/^\/jira\/software\/c\/projects\/IOS\/list\/?$/i.test(url.pathname)) return null;
    if (url.searchParams.get("groupBy") !== sprintField) return null;
    return { jql: url.searchParams.get("jql")?.trim() || null, id: url.pathname + url.search };
  }

  function groupKey(label) {
    const name = normalize(label);
    if (name === "Backlog") return "backlog";
    if (name === "Completed sprint") return "completed";
    return "sprint:" + name;
  }

  function indexIssues(issues) {
    const groups = new Map();
    const seen = new Set();
    for (const { key, fields } of issues) {
      if (typeof key !== "string" || !fields || !Object.hasOwn(fields, sprintField)) {
        throw new Error("Jira did not return sprint data");
      }
      if (seen.has(key)) continue;
      seen.add(key);

      const history = fields[sprintField] ?? [];
      if (!Array.isArray(history) || history.some((sprint) =>
        !sprint || typeof sprint.name !== "string" || !["active", "future", "closed"].includes(sprint.state)
      )) {
        throw new Error("Jira returned an unexpected sprint");
      }

      const current = history.filter((sprint) => sprint.state !== "closed");
      const buckets = current.length
        ? current.map((sprint) => "sprint:" + normalize(sprint.name))
        : [history.length ? "completed" : "backlog"];

      const points = fields[pointsField];
      for (const bucket of buckets) {
        if (!groups.has(bucket)) groups.set(bucket, new Map());
        groups.get(bucket).set(key, points === null || Number.isFinite(points) ? points : undefined);
      }
    }
    return groups;
  }

  async function fetchGroups(jql, origin, request = fetch) {
    const tokens = new Set();
    const issues = [];
    let nextPageToken;
    do {
      const url = new URL("/rest/api/3/search/jql", origin);
      url.search = new URLSearchParams({
        jql,
        fields: [sprintField, pointsField].join(","),
        maxResults: "100"
      });
      if (nextPageToken) url.searchParams.set("nextPageToken", nextPageToken);
      const response = await request(url, {
        credentials: "same-origin",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error("Jira search returned " + response.status);

      const page = await response.json();
      if (!Array.isArray(page.issues)) throw new Error("Jira did not return issues");
      issues.push(...page.issues);
      nextPageToken = page.nextPageToken;
      if (page.isLast === true) break;
      if (!nextPageToken && page.isLast === false) throw new Error("Jira search is incomplete");
      if (nextPageToken) {
        if (tokens.has(nextPageToken) || tokens.size >= 24) throw new Error("Jira search is incomplete");
        tokens.add(nextPageToken);
      }
    } while (nextPageToken);

    return indexIssues(issues);
  }

  function parsePoints(text) {
    const value = normalize(text);
    if (/^(?:none|[–—-])?$/i.test(value)) return null;
    if (!/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(value)) return undefined;
    const number = Number(value.replace(",", "."));
    return Number.isFinite(number) ? number : undefined;
  }

  function summarize(visible, expected, fetched) {
    const complete = (items) => items.size === expected && [...items.values()].every(
      (points) => points === null || Number.isFinite(points)
    );
    let items = visible;
    if (!complete(items)) {
      if (!fetched || fetched.size !== expected || [...visible.keys()].some((key) => !fetched.has(key))) {
        return null;
      }
      items = new Map(fetched);
      for (const [key, points] of visible) {
        if (points !== undefined) items.set(key, points);
      }
      if (!complete(items)) return null;
    }

    let estimated = 0;
    let points = 0;
    for (const value of items.values()) {
      if (value === null) continue;
      estimated++;
      points += value;
    }
    return { estimated, unestimated: expected - estimated, points };
  }

  const api = { fetchGroups, groupKey, indexIssues, normalize, parsePoints, summarize, viewFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.jiraSprintEstimates = api;
})();
