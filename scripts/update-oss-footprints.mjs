#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const START = "<!-- OSS_FOOTPRINTS_START -->";
const END = "<!-- OSS_FOOTPRINTS_END -->";

const username = process.env.GITHUB_USERNAME || "hcsum";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const readmePath = process.env.README_PATH || "README.md";
const lookbackDays = Number(process.env.LOOKBACK_DAYS || 180);
const checkOnly = process.argv.includes("--check");

if (!token) {
  throw new Error("Missing GITHUB_TOKEN or GH_TOKEN.");
}

const queries = [
  { kind: "PR", score: 3, q: `is:public is:pr author:${username} archived:false` },
  { kind: "Issue", score: 2, q: `is:public is:issue author:${username} archived:false` },
  { kind: "Comment", score: 1, q: `is:public commenter:${username} archived:false` },
  { kind: "Review", score: 2, q: `is:public is:pr reviewed-by:${username} archived:false` },
];

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": `${username}-oss-footprints`,
  "X-GitHub-Api-Version": "2022-11-28",
};

function repoFromItem(item) {
  return item.repository_url.replace("https://api.github.com/repos/", "");
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function searchIssues(query) {
  const url = new URL("https://api.github.com/search/issues");
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  url.searchParams.set("q", `${query.q} updated:>=${since}`);
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", "50");

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub search failed for "${query.q}": ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.items.map((item) => ({ ...item, footprintKind: query.kind, footprintScore: query.score }));
}

async function getPublicRepos(items) {
  const repos = new Map();

  for (const item of items) {
    const repo = repoFromItem(item);
    if (repos.has(repo)) continue;

    const response = await fetch(item.repository_url, { headers });
    if (!response.ok) {
      repos.set(repo, false);
      continue;
    }

    const data = await response.json();
    repos.set(repo, data.private === false && data.archived === false);
  }

  return repos;
}

function aggregate(items, publicRepos) {
  const repos = new Map();
  const seen = new Set();

  for (const item of items) {
    const repo = repoFromItem(item);
    if (!publicRepos.get(repo)) continue;

    const key = `${repo}:${item.html_url}:${item.footprintKind}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const current = repos.get(repo) || {
      repo,
      score: 0,
      updatedAt: item.updated_at,
      counts: new Map(),
      latest: item,
    };

    current.score += item.footprintScore;
    current.counts.set(item.footprintKind, (current.counts.get(item.footprintKind) || 0) + 1);

    if (new Date(item.updated_at) > new Date(current.updatedAt)) {
      current.updatedAt = item.updated_at;
      current.latest = item;
    }

    repos.set(repo, current);
  }

  return [...repos.values()]
    .sort((a, b) => b.score - a.score || new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 8);
}

function countSummary(counts) {
  const order = ["PR", "Issue", "Review", "Comment"];
  return order
    .filter((kind) => counts.has(kind))
    .map((kind) => `${counts.get(kind)} ${kind}${counts.get(kind) > 1 ? "s" : ""}`)
    .join(", ");
}

function render(repos) {
  if (repos.length === 0) {
    return "_No recent public GitHub activity found._";
  }

  const lines = [];

  for (const repo of repos) {
    const latest = repo.latest;
    const repoLink = `[\`${repo.repo}\`](https://github.com/${repo.repo})`;
    const latestLink = `[${escapeTable(latest.title)}](${latest.html_url})`;

    lines.push(
      `- ${repoLink} — ${countSummary(repo.counts)}  \n` +
        `  Latest: ${latest.footprintKind} ${latestLink} (${formatDate(latest.updated_at)})`,
    );
  }

  return lines.join("\n");
}

function replaceSection(readme, section) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README must contain ${START} and ${END}.`);
  }

  return `${readme.slice(0, start + START.length)}\n${section}\n${readme.slice(end)}`;
}

const results = await Promise.all(queries.map(searchIssues));
const items = results.flat();
const publicRepos = await getPublicRepos(items);
const repos = aggregate(items, publicRepos);
const section = render(repos);
const readme = await readFile(readmePath, "utf8");
const nextReadme = replaceSection(readme, section);

if (checkOnly) {
  if (readme !== nextReadme) {
    throw new Error("README.md is not up to date. Run scripts/update-oss-footprints.mjs.");
  }
} else if (readme !== nextReadme) {
  await writeFile(readmePath, nextReadme);
}

console.log(`Rendered ${repos.length} repos for ${username}.`);
