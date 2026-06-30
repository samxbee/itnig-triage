const https = require("https");

// ── helpers ──────────────────────────────────────────────
function get(url, headers = {}) {
  return new Promise((resolve) => {
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
    }).on("error", () => resolve({}));
  });
}

function parseTally(body) {
  const fields = body?.data?.fields || [];
  const get = (label) =>
    fields.find((f) => f.label?.toLowerCase().includes(label))?.value || "";
  return {
    company_name:           get("company name"),
    website:                get("website"),
    github_url:             get("github"),
    ph_url:                 get("product hunt"),
    linkedin_company_url:   get("linkedin company"),
    founder_linkedin_url:   get("founder linkedin"),
    stage:                  get("stage"),
    round_size:             get("round size") || "0",
    country:                get("country"),
    one_liner:              get("one-liner") || get("one liner"),
    moat:                   get("moat") || get("competitor"),
    cap_table:              get("cap table"),
  };
}

// ── AUTO-REJECT ───────────────────────────────────────────
function autoReject(d) {
  const reasons = [];
  const stage = (d.stage || "").toLowerCase();
  const size  = parseInt(d.round_size) || 0;
  const cap   = (d.cap_table || "").toLowerCase();
  const geo   = (d.country || "").toLowerCase();

  if (["series-a","series-b","series a","series b"].includes(stage))
    reasons.push("Stage too late — Itnig focuses on pre-seed/seed");
  if (size > 1_500_000)
    reasons.push("Round > €1.5M — outside Itnig ticket scope");
  if (cap.includes("complicated") || cap.includes("holding"))
    reasons.push("Cap table complexity flagged — clean up before raising");
  const euGeos = ["spain","españa","es","portugal","france","germany",
                  "netherlands","uk","sweden","italy","barcelona","madrid"];
  if (geo && !euGeos.some((g) => geo.includes(g)))
    reasons.push("Geography outside Itnig focus (Spain / EU)");
  return reasons;
}

// ── FAST CHECKS ───────────────────────────────────────────
async function checkGitHub(url, token) {
  if (!url || !token) return { score: 0, note: "No GitHub URL or token" };
  try {
    const parts = url.replace(/\/$/, "").split("/");
    const [owner, repo] = parts.slice(-2);
    const data = await get(
      `https://api.github.com/repos/${owner}/${repo}`,
      { Authorization: `token ${token}` }
    );
    const pushed   = data.pushed_at?.slice(0, 10) || "";
    const daysAgo  = pushed
      ? Math.floor((Date.now() - new Date(pushed)) / 86400000)
      : 999;
    const active   = daysAgo < 90;
    const score    = active ? 5 : (daysAgo < 180 ? 2 : 0);
    return { score, stars: data.stargazers_count || 0,
             last_push: pushed, active_90d: active };
  } catch { return { score: 0, note: "GitHub check failed" }; }
}

async function checkProductHunt(url, token) {
  if (!url || !token) return { score: 0, note: "No PH URL or token" };
  try {
    const slug  = url.replace(/\/$/, "").split("/").pop();
    const query = `{ post(slug:"${slug}") { votesCount commentsCount } }`;
    const body  = JSON.stringify({ query });
    const data  = await new Promise((resolve) => {
      const req = https.request(
        { hostname: "api.producthunt.com", path: "/v2/api/graphql",
          method: "POST",
          headers: { "Content-Type": "application/json",
                     Authorization: `Bearer ${token}`,
                     "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        }
      );
      req.write(body);
      req.end();
    });
    const post   = data?.data?.post || {};
    const votes  = post.votesCount || 0;
    const score  = votes > 100 ? 4 : votes > 20 ? 2 : votes > 0 ? 1 : 0;
    return { score, votes, comments: post.commentsCount || 0 };
  } catch { return { score: 0, note: "Product Hunt check failed" }; }
}

async function checkRedditFast(name) {
  if (!name) return { score: 0, note: "No company name" };
  try {
    const enc   = encodeURIComponent(name);
    const data  = await get(
      `https://www.reddit.com/search.json?q=${enc}&limit=5&sort=relevance`
    );
    const posts = data?.data?.children || [];
    const flags = ["scam","fraud","shutdown","shut down","dead","avoid","fake"];
    for (const p of posts) {
      const title = (p.data?.title || "").toLowerCase();
      if (flags.some((f) => title.includes(f)))
        return { score: -5, flag: true, note: `Red flag: ${title.slice(0, 80)}` };
    }
    return { score: posts.length > 0 ? 3 : 0, mentions: posts.length, flag: false };
  } catch { return { score: 0, note: "Reddit fast check failed" }; }
}

async function checkLinkedIn(url, key) {
  if (!url || !key) return { score: 0, note: "LinkedIn skipped — no Proxycurl key" };
  try {
    const enc  = encodeURIComponent(url);
    const data = await get(
      `https://nubela.co/proxycurl/api/linkedin/company?url=${enc}`,
      { Authorization: `Bearer ${key}` }
    );
    const headcount = data?.company_size_on_linkedin?.[0] || 0;
    return { score: headcount >= 2 ? 5 : 2, headcount, name: data.name };
  } catch { return { score: 0, note: "LinkedIn check failed" }; }
}

// ── DEEP CHECKS ───────────────────────────────────────────
async function checkCrunchbase(name, key) {
  if (!key) return { score: 0, note: "Crunchbase skipped — no key" };
  try {
    const body = JSON.stringify({
      field_ids: ["funding_stage","last_funding_type","last_funding_at","num_funding_rounds"],
      query: [{ type:"predicate", field_id:"name",
                operator_id:"contains", values:[name] }],
      limit: 1,
    });
    const data = await new Promise((resolve) => {
      const req = https.request(
        { hostname: "api.crunchbase.com",
          path: `/api/v4/searches/organizations?user_key=${key}`,
          method: "POST",
          headers: { "Content-Type": "application/json",
                     "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        }
      );
      req.write(body);
      req.end();
    });
    const props = data?.entities?.[0]?.properties || {};
    const stage = props.funding_stage || "";
    const score = ["pre_seed","seed"].includes(stage) ? 8 : stage ? 3 : 0;
    return { score, stage, last_funding: props.last_funding_at || "" };
  } catch { return { score: 0, note: "Crunchbase check failed" }; }
}

async function checkApollo(founderLinkedin, key) {
  if (!founderLinkedin || !key) return { score: 0, note: "Apollo skipped — no key" };
  try {
    const body = JSON.stringify({ linkedin_url: founderLinkedin, api_key: key });
    const data = await new Promise((resolve) => {
      const req = https.request(
        { hostname: "api.apollo.io", path: "/v1/people/match",
          method: "POST",
          headers: { "Content-Type": "application/json",
                     "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        }
      );
      req.write(body);
      req.end();
    });
    const person   = data?.person || {};
    const history  = person.employment_history || [];
    const hasExit  = history.some((e) => JSON.stringify(e).toLowerCase().includes("exit"));
    const hasB2B   = history.some((e) => {
      const s = JSON.stringify(e).toLowerCase();
      return s.includes("saas") || s.includes("b2b") || s.includes("enterprise");
    });
    return { score: (hasExit ? 6 : 0) + (hasB2B ? 4 : 0),
             prior_exit: hasExit, b2b_exp: hasB2B };
  } catch { return { score: 0, note: "Apollo check failed" }; }
}

async function checkRedditDeep(name) {
  if (!name) return { score: 0, note: "No company name" };
  try {
    const enc  = encodeURIComponent(name);
    const subs = ["SaaS", "startups", "indiehackers", "entrepreneur"];
    let organic = 0, total = 0;
    for (const sub of subs) {
      const data  = await get(
        `https://www.reddit.com/r/${sub}/search.json?q=${enc}&restrict_sr=1&sort=top&limit=5`
      );
      const posts = data?.data?.children || [];
      total      += posts.length;
      organic    += posts.filter((p) => (p.data?.score || 0) > 5).length;
    }
    return { score: Math.min(organic * 3, 10), organic_posts: organic, total };
  } catch { return { score: 0, note: "Reddit deep check failed" }; }
}

// ── SCORING ENGINE ────────────────────────────────────────
function computeScore(d, checks) {
  const dim = { thesis_fit: 0, team: 0, product: 0, traction_round: 0, cap_table: 0 };

  // 1. Thesis fit (max 25)
  const liner = (d.one_liner || "").toLowerCase();
  const moat  = (d.moat || "").toLowerCase();
  if (liner.includes("b2b"))                                       dim.thesis_fit += 10;
  if (["pre-seed","pre seed","preseed"].some(s => (d.stage||"").toLowerCase().includes(s)))
                                                                   dim.thesis_fit += 5;
  const esGeos = ["spain","españa","es","barcelona","madrid"];
  if (esGeos.some(g => (d.country||"").toLowerCase().includes(g))) dim.thesis_fit += 5;
  if (["workflow","automat","integr"].some(w => liner.includes(w))) dim.thesis_fit += 8;
  if (liner.includes("ai") && !liner.includes("workflow"))         dim.thesis_fit -= 10;
  if (liner.includes("like") && liner.includes("but in spain"))    dim.thesis_fit -= 10;

  // 2. Team (max 20)
  dim.team += checks.apollo?.score  || 0;
  dim.team += checks.linkedin?.score || 0;

  // 3. Product (max 20)
  dim.product += checks.github?.score       || 0;
  dim.product += checks.producthunt?.score  || 0;
  if (["data","integr","regulat","switch","proprietary"].some(k => moat.includes(k)))
    dim.product += 8;

  // 4. Traction & Round (max 20)
  dim.traction_round += checks.crunchbase?.score   || 0;
  dim.traction_round += checks.reddit_deep?.score  || 0;
  const size = parseInt(d.round_size) || 0;
  if (size >= 100_000 && size <= 500_000) dim.traction_round += 8;
  else if (size > 1_000_000)              dim.traction_round -= 10;
  if (checks.reddit_fast?.flag)           dim.traction_round -= 10;

  // 5. Cap table (max 15)
  const cap = (d.cap_table || "").toLowerCase();
  if (cap === "yes" || cap === "clean")    dim.cap_table += 10;
  else if (cap === "no")                   dim.cap_table -= 8;

  const total = Math.max(0, Math.min(100, Object.values(dim).reduce((a, b) => a + b, 0)));
  const verdict =
    total >= 80 ? "FAST_TRACK" :
    total >= 65 ? "PRIORITY"   :
    total >= 40 ? "REVIEW"     : "REJECT";

  return { total, verdict, dimensions: dim };
}

// ── HANDLER ───────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 200,
             headers: { "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Headers": "Content-Type" },
             body: "" };

  const keys = {
    GITHUB_TOKEN:   process.env.GITHUB_TOKEN,
    PH_TOKEN:       process.env.PH_TOKEN,
    PROXYCURL_KEY:  process.env.PROXYCURL_KEY,
    CRUNCHBASE_KEY: process.env.CRUNCHBASE_KEY,
    APOLLO_KEY:     process.env.APOLLO_KEY,
