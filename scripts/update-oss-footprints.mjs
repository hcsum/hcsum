#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const START = "<!-- OSS_FOOTPRINTS_START -->";
const END = "<!-- OSS_FOOTPRINTS_END -->";

const username = process.env.GITHUB_USERNAME || "hcsum";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const readmePath = process.env.README_PATH || "README.md";
const chartPath = process.env.OSS_FOOTPRINTS_CHART_PATH || "assets/oss-footprints.svg";
const lookbackDays = Number(process.env.LOOKBACK_DAYS || 180);
const checkOnly = process.argv.includes("--check");

if (!token) {
  throw new Error("Missing GITHUB_TOKEN or GH_TOKEN.");
}

const queries = [
  { kind: "PR", score: 1, q: `is:public is:pr author:${username} archived:false` },
  { kind: "Issue", score: 1, q: `is:public is:issue author:${username} archived:false` },
  { kind: "Comment", score: 1, q: `is:public commenter:${username} archived:false` },
  { kind: "Review", score: 1, q: `is:public is:pr reviewed-by:${username} archived:false` },
];

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": `${username}-oss-footprints`,
  "X-GitHub-Api-Version": "2022-11-28",
};

const repoInterests = new Map([
  ["anomalyco/opencode", "AI coding agents, terminal UX, plugin/runtime behavior"],
  ["mem0ai/mem0", "agent memory, extraction quality, self-hosted infrastructure"],
  ["grinev/opencode-telegram-bot", "chat-based coding workflows and permission UX"],
  ["vendurehq/vendure", "commerce admin UX and framework edge cases"],
  ["eze-is/web-access", "browser automation, local CDP workflows, agent tooling"],
  ["SillyTavern/SillyTavern", "AI roleplay interfaces and extensible chat UX"],
  ["jaredpalmer/formik", "React form behavior and long-lived library ergonomics"],
  ["smplrspace/react-fps-stats", "small developer tools for runtime visibility"],
]);

const repoCategories = new Map([
  ["anomalyco/opencode", "AI harness"],
  ["mem0ai/mem0", "AI harness"],
  ["grinev/opencode-telegram-bot", "AI harness"],
  ["vendurehq/vendure", "Commerce platforms"],
  ["eze-is/web-access", "AI harness"],
  ["SillyTavern/SillyTavern", "AI harness"],
  ["jaredpalmer/formik", "Frontend libraries"],
  ["smplrspace/react-fps-stats", "Developer tools"],
]);

const categoryColors = new Map([
  ["AI harness", "#2563eb"],
  ["Commerce platforms", "#16a34a"],
  ["Frontend libraries", "#dc2626"],
  ["Developer tools", "#9333ea"],
  ["Other public work", "#64748b"],
]);

function repoFromItem(item) {
  return item.repository_url.replace("https://api.github.com/repos/", "");
}

function cleanDescription(value) {
  return String(value || "")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .replace(/[.。]\s*$/, "")
    .trim();
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
      repos.set(repo, null);
      continue;
    }

    const data = await response.json();
    repos.set(repo, data.private === false && data.archived === false ? data : null);
  }

  return repos;
}

function aggregate(items, repoMetadata) {
  const repos = new Map();
  const seen = new Set();

  for (const item of items) {
    const repo = repoFromItem(item);
    if (repo === `${username}/${username}`) continue;

    const metadata = repoMetadata.get(repo);
    if (!metadata) continue;

    const key = `${repo}:${item.html_url}:${item.footprintKind}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const current = repos.get(repo) || {
      repo,
      score: 0,
      updatedAt: item.updated_at,
      counts: new Map(),
      latest: item,
      metadata,
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

function interestFor(repo) {
  const curated = repoInterests.get(repo.repo);
  if (curated) return curated;

  const description = cleanDescription(repo.metadata.description);
  if (description) return description;

  const topics = repo.metadata.topics || [];
  if (topics.length > 0) return topics.slice(0, 4).join(", ");

  return "recently touched public work";
}

function categoryFor(repo) {
  const curated = repoCategories.get(repo.repo);
  if (curated) return curated;

  const searchable = [
    repo.repo,
    repo.metadata.description,
    ...(repo.metadata.topics || []),
  ]
    .join(" ")
    .toLowerCase();

  if (/\b(ai|agent|llm|chatbot|automation|browser|cdp|memory)\b/.test(searchable)) {
    return "AI harness";
  }

  if (/\b(commerce|ecommerce|shop|storefront|checkout|payment|admin)\b/.test(searchable)) {
    return "Commerce platforms";
  }

  if (/\b(react|frontend|form|ui|component|css|javascript|typescript)\b/.test(searchable)) {
    return "Frontend libraries";
  }

  if (/\b(cli|tool|debug|stats|observability|developer)\b/.test(searchable)) {
    return "Developer tools";
  }

  return "Other public work";
}

function categoryBreakdown(repos) {
  const totals = new Map();

  for (const repo of repos) {
    const category = categoryFor(repo);
    const current = totals.get(category) || { category, score: 0, repos: 0, repoNames: [] };
    current.score += repo.score;
    current.repos += 1;
    current.repoNames.push(repo.repo);
    totals.set(category, current);
  }

  const totalScore = [...totals.values()].reduce((sum, item) => sum + item.score, 0);

  return [...totals.values()]
    .map((item) => ({
      ...item,
      repoNames: item.repoNames.sort((a, b) => a.localeCompare(b)),
      percent: totalScore === 0 ? 0 : (item.score / totalScore) * 100,
    }))
    .sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
}

function roundedPercents(breakdown) {
  const rounded = breakdown.map((item) => ({
    ...item,
    roundedPercent: Math.floor(item.percent),
    remainder: item.percent - Math.floor(item.percent),
  }));
  let missing = 100 - rounded.reduce((sum, item) => sum + item.roundedPercent, 0);

  for (const item of [...rounded].sort((a, b) => b.remainder - a.remainder)) {
    if (missing <= 0) break;
    item.roundedPercent += 1;
    missing -= 1;
  }

  return rounded;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderChart(repos) {
  const breakdown = roundedPercents(categoryBreakdown(repos));
  const radius = 58;
  const circumference = 2 * Math.PI * radius;
  let offset = 25;

  const segments = breakdown
    .filter((item) => item.percent > 0)
    .map((item) => {
      const dash = (item.percent / 100) * circumference;
      const gap = Math.max(circumference - dash, 0);
      const color = categoryColors.get(item.category) || categoryColors.get("Other public work");
      const segment = `<circle cx="84" cy="84" r="${radius}" fill="none" stroke="${color}" stroke-width="28" stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" stroke-linecap="butt" transform="rotate(-90 84 84)" />`;
      offset -= dash;
      return segment;
    });

  const legend = breakdown
    .map((item, index) => {
      const y = 92 + index * 44;
      const color = categoryColors.get(item.category) || categoryColors.get("Other public work");
      return [
        `<circle cx="244" cy="${y - 5}" r="6" fill="${color}" />`,
        `<text x="260" y="${y}" font-size="15" font-weight="600" fill="#111827">${escapeXml(item.category)}</text>`,
        `<text x="548" y="${y}" font-size="15" font-weight="700" text-anchor="end" fill="#111827">${item.roundedPercent}%</text>`,
        `<text x="260" y="${y + 18}" font-size="12" fill="#6b7280">${item.score} interactions across ${item.repos} ${item.repos === 1 ? "repo" : "repos"}</text>`,
      ].join("\n");
    })
    .join("\n");

  const totalSignals = repos.reduce((sum, repo) => sum + repo.score, 0);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="260" viewBox="0 0 720 260" role="img" aria-labelledby="title desc" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">
  <title id="title">OSS footprint category breakdown</title>
  <desc id="desc">A donut chart showing GitHub interactions by project category.</desc>
  <rect width="720" height="260" rx="18" fill="#ffffff" />
  <rect x="0.5" y="0.5" width="719" height="259" rx="17.5" fill="none" stroke="#e5e7eb" />
  <text x="34" y="38" font-size="18" font-weight="700" fill="#111827">OSS Footprint</text>
  <g transform="translate(34 60)">
    <circle cx="84" cy="84" r="${radius}" fill="none" stroke="#f3f4f6" stroke-width="28" />
    ${segments.join("\n    ")}
    <circle cx="84" cy="84" r="42" fill="#ffffff" />
    <text x="84" y="80" text-anchor="middle" font-size="24" font-weight="800" fill="#111827">${totalSignals}</text>
    <text x="84" y="100" text-anchor="middle" font-size="12" fill="#6b7280">interactions</text>
  </g>
  <g>
${legend}
  </g>
</svg>
`;
}

function searchUrl(repo, kind) {
  const qualifiers = {
    PR: `repo:${repo} is:pr author:${username}`,
    Issue: `repo:${repo} is:issue author:${username}`,
    Review: `repo:${repo} is:pr reviewed-by:${username}`,
    Comment: `repo:${repo} commenter:${username}`,
  };

  const query = `${qualifiers[kind]} archived:false`;
  return `https://github.com/search?q=${encodeURIComponent(query)}&type=issues`;
}

function interactionSummary(repo, counts) {
  const labels = new Map([
    ["PR", ["PR", "PRs"]],
    ["Issue", ["issue", "issues"]],
    ["Review", ["review", "reviews"]],
    ["Comment", ["comment", "comments"]],
  ]);

  return ["PR", "Issue", "Review", "Comment"]
    .filter((kind) => counts.has(kind))
    .map((kind) => {
      const count = counts.get(kind);
      const [singular, plural] = labels.get(kind);
      const label = `${count} ${count === 1 ? singular : plural}`;

      return `[${label}](${searchUrl(repo, kind)})`;
    })
    .join(", ");
}

function render(repos) {
  if (repos.length === 0) {
    return "_No recent public repo interactions found._";
  }

  const lines = [
    `<img src="${chartPath}" alt="OSS footprint category breakdown" width="720">`,
    "",
  ];

  for (const repo of repos) {
    const repoLink = `[\`${repo.repo}\`](https://github.com/${repo.repo})`;

    lines.push(
      `- ${repoLink}<br>\n` +
        `  ${interestFor(repo)}<br>\n` +
        `  Interactions: ${interactionSummary(repo.repo, repo.counts)}`,
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
const chart = renderChart(repos);
const readme = await readFile(readmePath, "utf8");
const currentChart = await readFile(chartPath, "utf8").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const nextReadme = replaceSection(readme, section);

if (checkOnly) {
  if (readme !== nextReadme || currentChart !== chart) {
    throw new Error("README.md is not up to date. Run scripts/update-oss-footprints.mjs.");
  }
} else {
  if (readme !== nextReadme) {
    await writeFile(readmePath, nextReadme);
  }

  if (currentChart !== chart) {
    await mkdir(dirname(chartPath), { recursive: true });
    await writeFile(chartPath, chart);
  }
}

console.log(`Rendered ${repos.length} repos for ${username}.`);
