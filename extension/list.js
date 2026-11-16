(() => {
  "use strict";

  const { fetchGroups, groupKey, normalize, parsePoints, summarize, viewFor } = jiraSprintEstimates;
  const marker = "data-jira-sprint-estimates";
  const rowSelector = 'tr, [role="row"]';
  const cellSelector = 'th, td, [role="columnheader"], [role="rowheader"], [role="cell"], [role="gridcell"]';
  const controlSelector = 'button, [role="button"]';
  const groupButton = /^(?:Expand|Collapse) group$/;
  const formatter = new Intl.NumberFormat(document.documentElement.lang || undefined, {
    maximumFractionDigits: 12
  });

  function label(element) {
    const references = element.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
    return normalize(
      references.map((id) => document.getElementById(id)?.textContent).join(" ") ||
      element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent
    );
  }

  function headerFor(row) {
    const toggle = [...row.querySelectorAll(controlSelector)].find((button) => groupButton.test(label(button)));
    if (!toggle) return null;
    const cell = toggle.closest(cellSelector);
    if (!cell) return null;

    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const words = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest(`[${marker}], ${controlSelector}, [hidden], [aria-hidden="true"]`)) continue;
      const value = normalize(node.textContent);
      if (value) words.push({ node, value });
    }

    const count = words.pop();
    if (!count || !/^\d[\d ,\u202f]*$/.test(count.value) || words.length === 0) return null;
    const total = Number(count.value.replace(/[\s,]/g, ""));
    if (!Number.isSafeInteger(total)) return null;

    // The number can sit inside a nested Jira badge. Find its branch beside the sprint name.
    let countAnchor = count.node;
    while (!countAnchor.parentElement.contains(words[0].node)) {
      countAnchor = countAnchor.parentElement;
    }

    return {
      cell,
      key: groupKey(words.map(({ value }) => value).join(" ")),
      total,
      countAnchor,
      expanded: label(toggle) === "Collapse group",
      visible: new Map()
    };
  }

  function issueKey(row) {
    for (const link of row.querySelectorAll('a[href*="/browse/"]')) {
      const match = /^\/browse\/(IOS-\d+)\/?$/i.exec(link.pathname);
      if (match) return match[1].toUpperCase();
    }
    return null;
  }

  function pointCellIndex(rows) {
    for (const row of rows) {
      const cells = [...row.children].filter((element) => element.matches(cellSelector));
      const index = cells.findIndex((element) => [...element.querySelectorAll(controlSelector)].some((button) =>
        /^Story Points(?:\s*•|$)/i.test(label(button))
      ));
      if (index !== -1) return index;
    }
    return -1;
  }

  function pointsIn(row, index) {
    const cells = [...row.children].filter((element) => element.matches(cellSelector));
    const edit = [...row.querySelectorAll(controlSelector)].find((button) =>
      /^Edit Story Points(?:\s*[,•:]|$)/i.test(label(button))
    );
    const cell = edit?.closest(cellSelector) ?? cells[index];
    if (!cell || cell.querySelector('input, [contenteditable="true"]')) return undefined;
    return parsePoints(cell.innerText ?? cell.textContent);
  }

  function readGroups() {
    for (const table of document.querySelectorAll('table, [role="table"], [role="grid"]')) {
      const rows = [...table.querySelectorAll(rowSelector)];
      const groups = [];
      let group = null;
      const pointIndex = pointCellIndex(rows);
      for (const row of rows) {
        const header = headerFor(row);
        if (header) {
          groups.push(header);
          group = header;
          continue;
        }
        if (!group?.expanded) continue;
        const key = issueKey(row);
        if (key) group.visible.set(key, pointsIn(row, pointIndex));
      }
      if (groups.length) return groups;
    }
    return [];
  }

  function paint(group, stats, status) {
    let badge = group.cell.querySelector(`[${marker}]`);
    if (!badge) {
      badge = document.createElement("span");
      badge.setAttribute(marker, "");
      group.countAnchor.after(badge);
    }

    const content = stats
      ? [`Estimated ${stats.estimated}`, `Unestimated ${stats.unestimated}`, `SP ${formatter.format(stats.points)}`]
      : [status];
    const text = content.join(" · ");
    if (badge.dataset.text === text) return;
    badge.dataset.text = text;
    badge.title = stats ? "Estimated tickets, unestimated tickets, and total Story Points" : text;
    badge.replaceChildren(...content.map((item, index) => {
      const part = document.createElement(index === 2 ? "strong" : "span");
      if (index === 2) part.className = "jse-points";
      part.textContent = index === 1 ? "· " + item : item;
      return part;
    }));
  }

  let snapshot = null;
  let timer = 0;
  let lastLocation = "";
  const cacheMs = 60_000;

  function requestSnapshot(view) {
    const current = { viewId: view.id, state: "loading", started: Date.now(), groups: null };
    snapshot = current;
    fetchGroups(view.jql, location.origin).then(
      (groups) => {
        current.state = "ready";
        current.groups = groups;
        schedule();
      },
      () => {
        current.state = "error";
        schedule();
      }
    );
    return current;
  }

  function render() {
    lastLocation = location.href;
    const view = viewFor(new URL(lastLocation));
    if (!view) {
      snapshot = null;
      document.querySelectorAll(`[${marker}]`).forEach((badge) => badge.remove());
      return;
    }
    if (snapshot?.viewId !== view.id) snapshot = null;
    const groups = readGroups();
    const localSearch = document.querySelector('input[placeholder="Search work"]')?.value.trim();
    // A local text filter may not be reflected in the URL's JQL.
    const canFetch = Boolean(view.jql && !localSearch);
    const needsFetch = groups.some((group) => !summarize(group.visible, group.total));
    if (canFetch && needsFetch && !document.hidden && snapshot?.state !== "loading" &&
        (!snapshot || Date.now() - snapshot.started >= cacheMs)) {
      requestSnapshot(view);
    }
    const fetched = canFetch ? snapshot?.groups : null;
    let status = "Expand this group to see estimates";
    if (canFetch && snapshot?.state === "loading") status = "Loading estimates…";
    else if (canFetch && snapshot?.state === "error") status = "Expand group · Jira search unavailable";
    for (const group of groups) {
      const stats = summarize(group.visible, group.total, fetched?.get(group.key));
      paint(group, stats, group.expanded && status === "Expand this group to see estimates"
        ? "Estimates unavailable for the full group"
        : status);
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      render();
    }, 80);
  }

  const observer = new MutationObserver((records) => {
    if (records.some(({ target }) => !(target.parentElement?.closest(`[${marker}]`) ||
      (target.nodeType === Node.ELEMENT_NODE && target.hasAttribute(marker))))) schedule();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["aria-label", "aria-expanded", "aria-labelledby", "title"] });
  document.addEventListener("input", schedule);
  document.addEventListener("visibilitychange", schedule);
  window.addEventListener("popstate", schedule);
  setInterval(() => {
    if (location.href !== lastLocation ||
        (snapshot && snapshot.state !== "loading" && Date.now() - snapshot.started >= cacheMs && !document.hidden)) {
      schedule();
    }
  }, 2_000);
  schedule();
})();
