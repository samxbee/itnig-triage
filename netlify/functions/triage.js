const https = require("https");

// ─── helpers ────────────────────────────────────────────────
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const options = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      headers: { "User-Agent": "itnig-triage/1.0", ...headers },
    };
    https.get(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({}); }
      });
    }).on("error", reject);
  });
}

function parseTally(body) {
  // Tally sends fields as an array: { fields: [{label, value}] }
  const fields = body?.data?.fields || [];
  const get = (label) =>
    fields.find((f) => f.label?.toLowerCase().includes(label.toLowerCase()))?.value || "";
  return {
    name:    get("name"),
    email:   get("email"),
    company: get("company"),
    website: get("website"),
    github:  get("github"),
    linkedin:get("linkedin"),
    idea:    get("idea") || get("description"),
  };
}

// ─── scoring signals ────────────────────────────────────────
async function checkGitHub(githubUrl, token) {
  if (!githubUrl || !token) return { stars: 0, repos: 0, commits: 0 };
  try {
    const username = githubUrl.replace(/.*github\.com\//, "").replace(/\/.*/, "");
    const user = await get(`https://api.github.com/users/${username}`, {
      Authorization: `token ${token}`,
    });
    const repos = await get(`https://api.github.com/users/${username}/repos?per_page=10&sort=updated`, {
      Authorization: `token ${token}`,
    });
    const stars = Array.isArray(repos)
      ? repos.reduce((s, r) => s + (r.stargazers_count || 0), 0)
      : 0;
    return { stars, repos: user.public_repos || 0, commits: stars > 0 ? 1 : 0 };
  } catch { return { stars: 0, repos: 0, commits: 0 }; }
}

async function checkApollo(email, apiKey) {
  if (!email || !apiKey) return { found: false };
  try {
    const data = await get(
      `https://api.apollo.io/v1/people/match?email=${encodeURIComponent(email)}&api_key=${apiKey}`
    );
    return {
      found: !!data?.person,
      title: data?.person?.title || "",
      company: data?.person?.organization?.name || "",
    };
  } catch { return { found: false }; }
}

// ─── score calculator ───────────────────────────────────────
function computeScore({ github, apollo, submission }) {
  let score = 0;
  const signals = [];

  if (github.stars > 50)  { score += 20; signals.push("GitHub stars > 50"); }
  if (github.repos > 5)   { score += 10; signals.push("Active GitHub"); }
  if (apollo.found)       { score += 20; signals.push("Found on Apollo"); }
  if (apollo.title)       { score += 10; signals.push(`Title: ${apollo.title}`); }
  if (submission.website) { score += 10; signals.push("Has website"); }
  if (submission.github)  { score += 10; signals.push("Provided GitHub"); }
  if (submission.linkedin){ score += 10; signals.push("Provided LinkedIn"); }
  if (submission.idea?.length > 100) { score += 10; signals.push("Detailed idea"); }

  return { score: Math.min(score, 100), signals };
}

// ─── main handler ───────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: "Invalid JSON" }; }

  const submission = parseTally(body);
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const APOLLO_KEY   = process.env.APOLLO_KEY;

  const [github, apollo] = await Promise.all([
    checkGitHub(submission.github, GITHUB_TOKEN),
    checkApollo(submission.email, APOLLO_KEY),
  ]);

  const { score, signals } = computeScore({ github, apollo, submission });

  const result = {
    timestamp: new Date().toISOString(),
    name:      submission.name,
    email:     submission.email,
    company:   submission.company,
    website:   submission.website,
    score,
    signals,
    github,
    apollo,
    raw: submission,
  };

  console.log("TRIAGE_RESULT", JSON.stringify(result));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, score, signals }),
  };
};
