import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

const CHROME = process.env.ECL_CHROME ||
  (process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "/usr/bin/google-chrome");
const THEME = process.env.ECL_THEME || "dark";
const BASE = process.env.ECL_BASE || path.join(here, "fixtures", THEME); // fixture dir
const OUT = process.env.ECL_OUT || path.join(here, "shots", THEME);      // screenshots

function fileUrl(p){
  let s = path.resolve(p).replace(/\\/g, "/");
  if(!s.startsWith("/")) s = "/" + s;
  return "file://" + s;
}

fs.mkdirSync(OUT, { recursive: true });

const pages = ["index.html","top.html","forum.html","teacher.html","conta.html","auth.html","admin.html","perfil.html"];
const widths = [[1440,900],[834,1112],[390,844]];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox","--allow-file-access-from-files"]
});

const results = [];
const consoleErrors = [];

async function shot(page, name){
  const side = await page.evaluate(() => {
    const s = document.getElementById("side");
    if(!s) return null;
    const c = s.querySelector(".sideCard");
    return { cls: s.className, op: c ? getComputedStyle(c).opacity : null, vis: c ? getComputedStyle(c).visibility : null };
  });
  if(side && side.cls.includes("open")){
    console.log("SIDE-SNAPSHOT " + name + " " + JSON.stringify(side));
  }
  await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });
  const after = await page.evaluate(() => {
    const s = document.getElementById("side");
    if(!s) return null;
    const c = s.querySelector(".sideCard");
    return { cls: s.className, op: c ? getComputedStyle(c).opacity : null };
  });
  if(after && after.cls.includes("open")){
    console.log("SIDE-AFTER " + name + " " + JSON.stringify(after));
  }
}

function log(name, ok, detail){
  results.push({ name, ok, detail: detail || "" });
  console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : ""));
}

// helper to open a page
async function open(p, file, w, h){
  await p.setViewport({ width: w, height: h });
  const url = fileUrl(path.join(BASE, file));
  const errs = [];
  p.on("console", m => {
    if(m.type() !== "error") return;
    const t = m.text();
    // pre-migration noise: forum_feed (and later news_count) RPCs not
    // yet applied on the live DB (client falls back / skips). Remove
    // after running setup.sql.
    const u = (m.location() && m.location().url) || "";
    if(/\/rpc\/(forum_feed|news_count)/.test(u) && /404/.test(t)) return;
    errs.push(t);
  });
  p.on("pageerror", e => errs.push(String(e)));
  await p.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  // wait for data / ECL
  await new Promise(r => setTimeout(r, 3500));
  return errs;
}

const browserPage = await browser.newPage();

// stale theme from a prior run must not leak into fixtures
{
  await open(browserPage, "index.html", 1440, 900);
  await browserPage.evaluate(() => { try{ localStorage.removeItem("ecl-theme"); }catch(e){} });
}

// ── Gate B: visual captures all pages × themes × widths ──
for(const [w,h] of widths){
  for(const file of pages){
    const errs = await open(browserPage, file, w, h);
    consoleErrors.push(...errs.map(e => file + "@" + w + ": " + e));
    await shot(browserPage, file.replace(".html","") + "-" + w + "-" + THEME);
    // mobile overflow check
    if(w === 390){
      const ov = await browserPage.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth
      }));
      log("overflow " + file + "@" + w + " " + THEME, ov.sw <= ov.iw, JSON.stringify(ov));
    }
  }
}

// ── Gate C: functional flows ──
// 1. index: load, count cards, accent search, filter, empty, clear
{
  const errs = await open(browserPage, "index.html", 1440, 900);
  const r = await browserPage.evaluate(() => ({
    ecl: typeof window.ECL === "object" && !!window.ECL.configured,
    cards: document.querySelectorAll(".tcard").length,
    rcount: (document.getElementById("rcount")||{}).textContent || "",
    navAcct: !!document.getElementById("acct"),
    acctHtml: (document.getElementById("acct")||{}).innerHTML || ""
  }));
  log("index ECL+data", r.ecl && r.cards > 0, JSON.stringify(r));
  log("index no page errors", errs.length === 0, errs.join("; "));

  // accent-insensitive search
  await browserPage.type("#q", "rosario");
  await new Promise(r => setTimeout(r, 400));
  const search = await browserPage.evaluate(() => ({
    cards: document.querySelectorAll(".tcard").length,
    rcount: (document.getElementById("rcount")||{}).textContent || ""
  }));
  log("index search rosario", search.cards >= 1, JSON.stringify(search));

  // clear + filter Docente
  await browserPage.evaluate(() => { document.getElementById("q").value = ""; });
  const fnOpts = await browserPage.evaluate(() => {
    const sel = document.getElementById("fn");
    return Array.from(sel.options).map(o => o.textContent);
  });
  log("index fn options built", fnOpts.length > 1, fnOpts.slice(0,5).join(" | "));
}

// 1b. index: loading skeleton + localStorage cache (slow stubs)
{
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Expose-Headers": "*"
  };
  const cTeachers = [{ id: 1, name: "Helga Duarte", subject: "Matemática", fn: "Docente" }];
  for(let i = 2; i <= 30; i++) cTeachers.push({ id: i, name: "Professor " + i, subject: "Disciplina " + (i % 4), fn: "Docente" });
  const cRatings = [
    { id: 11, teacher_id: 1, user_id: "u2", clareza: 5, apoio: 5, justica: 3, comment: "", created_at: "2026-10-10T10:00:00Z" }
  ];
  let delay = 1200;
  const onReq = req => {
    const u = req.url();
    const json = body => {
      setTimeout(() => {
        try { req.respond({ status: 200, headers: CORS, contentType: "application/json", body }); } catch(e){}
      }, delay);
    };
    if(u.includes("/rest/v1/teachers")) return json(JSON.stringify(cTeachers));
    if(u.includes("/rest/v1/ratings")) return json(JSON.stringify(cRatings));
    if(u.includes("/rest/v1/rpc/")) return json(JSON.stringify({}));
    return req.continue();
  };
  await browserPage.evaluate(() => {
    localStorage.removeItem("ecl-cache");
    localStorage.removeItem("ecl-session");
  });
  await browserPage.setRequestInterception(true);
  browserPage.on("request", onReq);
  try {
    await browserPage.setViewport({ width: 1440, height: 900 });
    await browserPage.goto(
      "file:///" + path.join(BASE, "index.html").replace(/\\/g, "/"),
      { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(r => setTimeout(r, 300));
    const sk = await browserPage.evaluate(() => ({
      sk: document.querySelectorAll("#list .sk").length,
      tcards: document.querySelectorAll(".tcard").length
    }));
    log("index skeleton while loading", sk.sk >= 3 && sk.tcards === 0, JSON.stringify(sk));

    await new Promise(r => setTimeout(r, 2500));
    const done = await browserPage.evaluate(() => ({
      sk: document.querySelectorAll("#list .sk").length,
      tcards: document.querySelectorAll(".tcard").length,
      rcount: (document.getElementById("rcount")||{}).textContent || ""
    }));
    log("index skeleton hides after load",
      done.sk === 0 && done.tcards === 30 && /^30 professores$/.test(done.rcount),
      JSON.stringify(done));

    // reload with an even slower network — cache must serve instantly
    delay = 5000;
    await browserPage.goto(
      "file:///" + path.join(BASE, "index.html").replace(/\\/g, "/"),
      { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(r => setTimeout(r, 600));
    const cached = await browserPage.evaluate(() => ({
      tcards: document.querySelectorAll(".tcard").length,
      sk: document.querySelectorAll("#list .sk").length
    }));
    log("index cache serves on reload",
      cached.tcards === 30 && cached.sk === 0,
      JSON.stringify(cached));

    // cache stored under ecl-cache with the shared key
    const ck = await browserPage.evaluate(() => {
      try {
        const all = JSON.parse(localStorage.getItem("ecl-cache") || "{}");
        return { keys: Object.keys(all), has: !!(all["d-index"] && all["d-index"].v) };
      } catch(e){ return { keys: [], has: false }; }
    });
    log("index cache key d-index", ck.has && ck.keys.indexOf("d-index") >= 0, JSON.stringify(ck));
  } finally {
    browserPage.off("request", onReq);
    await browserPage.setRequestInterception(false);
    // stub data must not leak into the live top/index checks below
    await browserPage.evaluate(() => localStorage.removeItem("ecl-cache"));
  }
}

// 2. top: load list, modes, criteria, chips
{
  const errs = await open(browserPage, "top.html", 1440, 900);
  const r = await browserPage.evaluate(() => ({
    rows: document.querySelectorAll(".rrow").length,
    ranked: document.querySelectorAll(".rrow:not(.norank)").length,
    few: document.querySelectorAll(".rrow.norank").length,
    fewHdr: (document.getElementById("list").textContent || "").includes("Avaliados poucas vezes"),
    hdr: (document.getElementById("rankHdr")||{}).textContent || "",
    segOn: !!document.querySelector(".seg .sortbtn.on"),
    chips: document.querySelectorAll("[data-role]").length,
    crits: document.querySelectorAll("[data-crit]").length,
    nota: !!document.getElementById("nota"),
    podium: document.querySelectorAll(".podium .p-card").length,
    podiumPos: Array.from(document.querySelectorAll(".podium .p-card")).map(c => c.getAttribute("data-pos")).join(""),
    podiumOrder: Array.from(document.querySelectorAll(".podium .p-card")).map(c => getComputedStyle(c).order).join(""),
    podiumFirst: !!document.querySelector('.podium .p-card.first[data-pos="1"]'),
    podiumState: (document.getElementById("list").textContent || "").indexOf("Ainda não há professores com 3") >= 0,
    restRank: ((document.querySelector(".rrow:not(.norank) .rrank") || {}).textContent || "").trim()
  }));
  log("top list", r.rows > 0 && r.segOn && r.chips > 1 && r.crits === 4 && !r.nota, JSON.stringify(r));
  log("top honesty (n>=3 ranked + few section)",
    r.rows > 0 && r.ranked + r.few === r.rows && /mínimo de 3/.test(r.hdr) && (r.few === 0 || r.fewHdr),
    JSON.stringify({ ranked: r.ranked, few: r.few, fewHdr: r.fewHdr, hdr: r.hdr.slice(0,80) }));
  log("top podium (2-1-3) + list from 4th",
    r.podium >= 1 && r.podium <= 3 && r.podiumFirst && !(r.podium > 0 && r.podiumState) &&
      (r.podium < 3 || (r.restRank === "4" && r.podiumOrder === "213" && r.podiumPos === "123")),
    JSON.stringify({ podium: r.podium, pos: r.podiumPos, order: r.podiumOrder, first: r.podiumFirst, restRank: r.restRank }));

  // mode toggle: avg + criterion changes header
  await browserPage.click("#sortAvg");
  await new Promise(r2 => setTimeout(r2, 300));
  const avg = await browserPage.evaluate(() => ({
    on: !!document.querySelector("#sortAvg.on"),
    pressed: document.getElementById("sortAvg").getAttribute("aria-pressed"),
    hdr: (document.getElementById("rankHdr")||{}).textContent || ""
  }));
  log("top avg mode", avg.on && avg.pressed === "true" && /Ordenado por média/.test(avg.hdr), JSON.stringify(avg));

  await browserPage.click('[data-crit="c"]');
  await new Promise(r2 => setTimeout(r2, 300));
  const cl = await browserPage.evaluate(() => ({
    on: !!document.querySelector('[data-crit="c"].on'),
    hdr: (document.getElementById("rankHdr")||{}).textContent || ""
  }));
  log("top crit clareza", cl.on && /Ordenado por clareza/.test(cl.hdr), JSON.stringify(cl));

  // role chip filter
  await browserPage.click('#sortCount');
  await new Promise(r2 => setTimeout(r2, 200));
  const chipSel = await browserPage.evaluate(() => {
    const chips = Array.from(document.querySelectorAll("[data-role]"));
    return chips.length > 1 ? chips[1].getAttribute("data-role") : null;
  });
  if(chipSel){
    await browserPage.click('[data-role="' + chipSel + '"]');
    await new Promise(r2 => setTimeout(r2, 300));
    const f = await browserPage.evaluate(() => ({
      on: !!document.querySelector('[data-role].on'),
      empty: (document.getElementById("list").textContent || "").indexOf("Nenhum professor") >= 0,
      rows: document.querySelectorAll(".rrow").length
    }));
    log("top role chip filter", f.on && (f.empty || f.rows > 0), JSON.stringify(f));
  }

  log("top no page errors", errs.length === 0, errs.join("; "));
}

// 3. forum: classic 3-view layout (home / list / thread), stubbed fixture
{
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Expose-Headers": "*"
  };
  const fTeachers = [{ id: 1, name: "Helga Duarte", subject: "Matemática" }];
  const fBranches = [
    { id: 5, name: "Sala dos Professores", access_view: "all",
      access_publish: "user", access_reply: "user" }
  ];
  const fPosts = [
    { id: 1, parent_id: null, title: "Dúvida sobre horários", content: "Conteúdo do tópico",
      author_name: "Ana", user_id: "u2", teacher_id: 1, branch_id: null,
      pinned: false, score: 0, created_at: "2026-10-12T10:00:00Z" },
    { id: 2, parent_id: null, title: "Regras da comunidade", content: "Lê antes de publicar",
      author_name: "gate", user_id: "u1", teacher_id: null, branch_id: null,
      pinned: true, score: 0, created_at: "2026-10-10T09:00:00Z" },
    { id: 3, parent_id: null, title: "Tópico na sala", content: "Só aqui",
      author_name: "Ana", user_id: "u2", teacher_id: null, branch_id: 5,
      pinned: false, score: 0, created_at: "2026-10-13T08:00:00Z" },
    { id: 4, parent_id: 1, content: "Resposta directa",
      author_name: "Ana", user_id: "u2", branch_id: null,
      created_at: "2026-10-12T11:00:00Z" },
    { id: 5, parent_id: 4, content: "Resposta aninhada",
      author_name: "Carlos", user_id: null, branch_id: null,
      created_at: "2026-10-12T12:00:00Z" }
  ];
  const fProfiles = [
    { id: "u1", username: "gate", role: "owner" },
    { id: "u2", username: "ana", role: "user", country: "PT",
      muted_until: null, banned: false }
  ];
  const fSession = {
    token: "gate-fake", exp: Math.floor(Date.now() / 1000) + 3600,
    username: "gate", role: "owner", id: "u1", created_at: "2026-01-01T00:00:00Z"
  };
  const onReq = req => {
    const u = req.url();
    const json = body => req.respond({ status: 200, headers: CORS, contentType: "application/json", body });
    if(u.includes("/rest/v1/teachers")) return json(JSON.stringify(fTeachers));
    if(u.includes("/rest/v1/forum_posts")) return json(JSON.stringify(fPosts));
    if(u.includes("/rest/v1/profiles")) return json(JSON.stringify(fProfiles));
    if(u.includes("/rest/v1/rpc/")){
      const fn = u.split("/rpc/")[1].split("?")[0];
      if(fn === "session_info" || fn === "login") return json(JSON.stringify(fSession));
      if(fn === "forum_feed") return json(JSON.stringify({ branches: fBranches, posts: fPosts }));
      if(fn === "news_count") return json(JSON.stringify({ count: 2 }));
      if(fn === "post_edit"){
        let body = {};
        try{ body = JSON.parse(req.postData() || "{}"); }catch(e){}
        return json(JSON.stringify({ id: body.p_id, content: body.p_content }));
      }
      return json(JSON.stringify({}));
    }
    return req.continue();
  };
  await browserPage.setRequestInterception(true);
  browserPage.on("request", onReq);

  try {
  // ensure anonymous baseline (clear any stub session from a prior run)
  await open(browserPage, "forum.html", 1440, 900);
  await browserPage.evaluate(() => {
    localStorage.removeItem("ecl-session");
    // last visit "before" the fixture posts (2026-10-12/13) → newdots
    localStorage.setItem("ecl-seen", "2026-10-11T00:00:00.000Z");
  });
  const errs = await open(browserPage, "forum.html", 1440, 900);
  const r = await browserPage.evaluate(() => {
    const vHome = document.getElementById("vHome");
    const vList = document.getElementById("vList");
    const vThread = document.getElementById("vThread");
    return {
      homeRows: document.querySelectorAll("#homeRows tr").length,
      recentRows: document.querySelectorAll("#recentRows tr").length,
      recentPin: !!document.querySelector("#recentRows .pinchip"),
      homeVisible: vHome && !vHome.classList.contains("hide"),
      listHidden: vList ? vList.classList.contains("hide") : false,
      threadHidden: vThread ? vThread.classList.contains("hide") : false,
      homeHeaders: Array.from(document.querySelectorAll("#vHome .ftbl th")).map(t => t.textContent.trim()),
      ntCardHidden: document.getElementById("ntCard").classList.contains("hide"),
      ntOpenHidden: document.getElementById("ntOpen").classList.contains("hide"),
      ntAnonShown: !document.getElementById("ntAnon").classList.contains("hide"),
      emoji: /💬/.test(document.body.textContent || ""),
      counts: document.querySelectorAll("#homeRows .num").length >= 2,
      truncHidden: document.getElementById("truncWarn") ?
        document.getElementById("truncWarn").classList.contains("hide") : false,
      noCreate: !document.getElementById("createWrap")
    };
  });
  log("forum home table",
    r.homeRows >= 2 && r.recentRows >= 1 && r.recentPin && r.homeVisible &&
      r.listHidden && r.threadHidden && r.truncHidden && r.noCreate &&
      r.homeHeaders.join("|") === "Comunidade|Tópicos|Mensagens|Última atividade",
    JSON.stringify(r));
  log("forum composer gated (anon)", r.ntCardHidden && r.ntOpenHidden && r.ntAnonShown,
    JSON.stringify({ ntCardHidden: r.ntCardHidden, ntOpenHidden: r.ntOpenHidden, ntAnonShown: r.ntAnonShown }));
  log("forum counts (no emoji)", !r.emoji && r.counts, JSON.stringify({ emoji: r.emoji, counts: r.counts }));
  log("forum no page errors", errs.length === 0, errs.join("; "));

  // M2: unread nav badge (stubbed news_count) + dots since last visit
  const news = await browserPage.evaluate(() => {
    const dot = document.querySelector('nav a[href="forum.html"] .navdot');
    return {
      newdots: document.querySelectorAll("#recentRows .newdot").length,
      badge: dot ? dot.textContent.trim() : null,
      badgeHidden: dot ? dot.classList.contains("hide") : true
    };
  });
  log("forum unread badge (stub news_count)",
    news.badge === "2" && !news.badgeHidden, JSON.stringify(news));
  log("forum newdot since last visit",
    news.newdots >= 2, JSON.stringify(news));

  // M2: grouped global search (topics / branches / teachers / people)
  await browserPage.type("#gq", "sala");
  await new Promise(r2 => setTimeout(r2, 300));
  const gs1 = await browserPage.evaluate(() => ({
    resultsShown: !document.getElementById("gResults").classList.contains("hide"),
    homeHidden: document.getElementById("gHome").classList.contains("hide"),
    topics: Array.from(document.querySelectorAll("#gTopics .tlink")).map(a => a.textContent),
    branches: Array.from(document.querySelectorAll("#gBranches .tlink")).map(a => a.textContent)
  }));
  log("forum global search topics+branches",
    gs1.resultsShown && gs1.homeHidden &&
      gs1.topics.some(t => t.indexOf("Tópico na sala") >= 0) &&
      gs1.branches.some(b => b.indexOf("Sala dos Professores") >= 0),
    JSON.stringify(gs1));

  await browserPage.evaluate(() => { document.getElementById("gq").value = ""; });
  await browserPage.type("#gq", "helga");
  await new Promise(r2 => setTimeout(r2, 300));
  const gs2 = await browserPage.evaluate(() => ({
    teachers: Array.from(document.querySelectorAll("#gTeachers .tlink")).map(a => a.textContent),
    peopleHidden: document.getElementById("gSecPeople").classList.contains("hide")
  }));
  log("forum global search teachers",
    gs2.teachers.some(t => t.indexOf("Helga Duarte") >= 0) && gs2.peopleHidden,
    JSON.stringify(gs2));

  await browserPage.evaluate(() => { document.getElementById("gq").value = ""; });
  await browserPage.type("#gq", "ana");
  await new Promise(r2 => setTimeout(r2, 300));
  const gs3 = await browserPage.evaluate(() => ({
    people: Array.from(document.querySelectorAll("#gPeople td")).map(td => td.textContent.trim())
  }));
  log("forum global search people",
    gs3.people.some(p => p.indexOf("ana") >= 0), JSON.stringify(gs3));

  await browserPage.evaluate(() => { document.getElementById("gq").value = ""; });
  await browserPage.type("#gq", "zzzzzqq");
  await new Promise(r2 => setTimeout(r2, 300));
  const gs4 = await browserPage.evaluate(() => ({
    state: (document.getElementById("gState").textContent || "").trim(),
    topicsHidden: document.getElementById("gSheetTopics").classList.contains("hide")
  }));
  log("forum global search empty state",
    /Nada corresponde/.test(gs4.state) && gs4.topicsHidden, JSON.stringify(gs4));

  await browserPage.evaluate(() => {
    const g = document.getElementById("gq");
    g.value = "";
    g.dispatchEvent(new Event("input"));
  });
  await new Promise(r2 => setTimeout(r2, 200));
  const gs5 = await browserPage.evaluate(() => ({
    homeVisible: !document.getElementById("gHome").classList.contains("hide"),
    resultsHidden: document.getElementById("gResults").classList.contains("hide")
  }));
  log("forum global search clears",
    gs5.homeVisible && gs5.resultsHidden, JSON.stringify(gs5));

  // navigation: home → community list
  await browserPage.click('#homeRows a.tlink');
  await new Promise(r2 => setTimeout(r2, 350));
  const nav = await browserPage.evaluate(() => ({
    hash: location.hash,
    listVisible: !document.getElementById("vList").classList.contains("hide"),
    homeHidden: document.getElementById("vHome").classList.contains("hide"),
    rows: document.querySelectorAll("#listRows tr").length,
    title: (document.getElementById("lTitle")||{}).textContent || "",
    counts: (document.getElementById("lCounts")||{}).textContent || ""
  }));
  log("forum navigation home to list",
    nav.hash === "#comunidade-0" && nav.listVisible && nav.homeHidden &&
      nav.rows === 2 && nav.title === "Geral" && /tópicos/.test(nav.counts),
    JSON.stringify(nav));

  // thread list columns + pinned chip
  const lst = await browserPage.evaluate(() => ({
    heads: Array.from(document.querySelectorAll("#listSheet th")).map(t => t.textContent.trim()),
    pin: !!document.querySelector("#listRows .pinchip"),
    firstIsPinned: !!document.querySelector("#listRows tr:first-child .pinchip")
  }));
  log("forum thread list columns",
    lst.heads.join("|") === "Tópico|Autor|Respostas|Última atividade" && lst.pin && lst.firstIsPinned,
    JSON.stringify(lst));

  // part of the topic text shown under each title
  const exq = await browserPage.evaluate(() =>
    Array.from(document.querySelectorAll("#listRows .texsum"))
      .map(e => e.textContent.trim()));
  log("forum topic text under title",
    exq.length >= 2 && exq.every(t => t.length > 0) &&
      exq.some(t => t.indexOf("Conteúdo do tópico") === 0),
    JSON.stringify(exq));

  // open thread (anon): OP + login CTA, no reply textarea
  await browserPage.click('#listRows a[href="#topico-1"]');
  await new Promise(r2 => setTimeout(r2, 400));
  const th = await browserPage.evaluate(() => ({
    threadVisible: !document.getElementById("vThread").classList.contains("hide"),
    op: !!document.querySelector("#threadMount .op"),
    back: (document.querySelector("#threadMount .backlink")||{}).textContent || "",
    anonCta: !!document.querySelector('#threadMount a[href^="auth.html"]'),
    textarea: !!document.querySelector("#threadMount textarea"),
    cmts: document.querySelectorAll("#threadMount .cmt").length
  }));
  log("forum thread open (anon)",
    th.threadVisible && th.op && th.anonCta && !th.textarea && th.back.indexOf("Geral") >= 0 && th.cmts >= 2,
    JSON.stringify(th));

  // flat thread: reply reference line + country flag next to the name
  const fl = await browserPage.evaluate(() => {
    const ref = document.querySelector("#threadMount .ref");
    const flag = document.querySelector("#threadMount .op .flag");
    return {
      ref: ref ? ref.textContent.trim() : "",
      flagSrc: flag ? flag.getAttribute("src") : "",
      flagAlt: flag ? flag.getAttribute("alt") : ""
    };
  });
  log("forum thread reply ref", fl.ref.indexOf("→ responder a") >= 0 && /ana/.test(fl.ref), JSON.stringify(fl));
  log("forum flag next to name",
    /flagcdn\.com\/20x15\/pt\.png/.test(fl.flagSrc) && fl.flagAlt === "PT",
    JSON.stringify(fl));

  // mobile: communities table in flow, legacy rail gone
  await open(browserPage, "forum.html", 390, 844);
  const m = await browserPage.evaluate(() => ({
    sideGone: !document.getElementById("side"),
    rows: document.querySelectorAll("#homeRows tr").length,
    homeVis: !document.getElementById("vHome").classList.contains("hide")
  }));
  log("forum mobile home table", m.sideGone && m.rows >= 2 && m.homeVis, JSON.stringify(m));

  // logged-in pass: composer button + create form hidden for plain users
  await browserPage.evaluate(() => localStorage.setItem("ecl-session", JSON.stringify({
    token: "gate-fake",
    exp: Math.floor(Date.now() / 1000) + 3600,
    username: "gate",
    role: "user"
  })));
  await open(browserPage, "forum.html", 1440, 900);
  await new Promise(r2 => setTimeout(r2, 700));
  const lg = await browserPage.evaluate(() => ({
    ntOpenShown: !document.getElementById("ntOpen").classList.contains("hide"),
    ntAnonHidden: document.getElementById("ntAnon").classList.contains("hide"),
    ntCardHidden: document.getElementById("ntCard").classList.contains("hide"),
    acctOk: ((document.getElementById("acct")||{}).innerHTML||"").includes("Olá"),
    noCreateWrap: !document.getElementById("createWrap"),
    noScForm: !document.getElementById("scForm")
  }));
  log("forum composer button (logged in)",
    lg.ntOpenShown && lg.ntAnonHidden && lg.ntCardHidden && lg.acctOk && lg.noCreateWrap && lg.noScForm,
    JSON.stringify(lg));

  await browserPage.click("#ntOpen");
  await new Promise(r2 => setTimeout(r2, 250));
  const comp = await browserPage.evaluate(() => ({
    cardShown: !document.getElementById("ntCard").classList.contains("hide"),
    openHidden: document.getElementById("ntOpen").classList.contains("hide")
  }));
  log("forum composer opens", comp.cardShown && comp.openHidden, JSON.stringify(comp));

  await browserPage.click("#ntCancel");
  await new Promise(r2 => setTimeout(r2, 250));
  const comp2 = await browserPage.evaluate(() => ({
    cardHidden: document.getElementById("ntCard").classList.contains("hide"),
    openShown: !document.getElementById("ntOpen").classList.contains("hide")
  }));
  log("forum composer cancels", comp2.cardHidden && comp2.openShown, JSON.stringify(comp2));

  // thread view: static reply box at the end of the thread
  await browserPage.evaluate(() => { location.hash = "#topico-1"; });
  await new Promise(r2 => setTimeout(r2, 400));
  const th2 = await browserPage.evaluate(() => {
    const rb = document.querySelector("#threadMount .rbox");
    return {
      rbox: !!rb,
      rboxPos: rb ? getComputedStyle(rb).position : "",
      textarea: !!document.querySelector("#threadMount textarea")
    };
  });
  log("forum thread reply box",
    th2.rbox && th2.rboxPos === "static" && th2.textarea,
    JSON.stringify(th2));

  // owner pass: pin controls on the topic (goto of the identical URL is a
  // same-document no-op — force a real reload so the thread re-renders)
  await browserPage.evaluate(() => localStorage.setItem("ecl-session", JSON.stringify({
    token: "gate-fake",
    exp: Math.floor(Date.now() / 1000) + 3600,
    username: "gate",
    role: "owner",
    id: "u1"
  })));
  await browserPage.setViewport({ width: 1440, height: 900 });
  await browserPage.reload({ waitUntil: "networkidle2", timeout: 60000 });
  await new Promise(r2 => setTimeout(r2, 3500));
  const ow = await browserPage.evaluate(() => {
    const pin = document.querySelector("#threadMount [data-pin]");
    return {
      threadVisible: !document.getElementById("vThread").classList.contains("hide"),
      pin: pin ? pin.textContent.trim() : "",
      del: !!document.querySelector("#threadMount [data-del]")
    };
  });
  log("forum owner pin controls",
    ow.threadVisible && ow.pin === "fixar" && ow.del, JSON.stringify(ow));

  // M2: edit is author-only — the owner did not write topic 1 (u2 did)
  const noEd = await browserPage.evaluate(() => ({
    opEdit: !!document.querySelector("#threadMount .op [data-edit]"),
    anyEdit: document.querySelectorAll("#threadMount [data-edit]").length
  }));
  log("forum edit button only for author",
    !noEd.opEdit && noEd.anyEdit === 0, JSON.stringify(noEd));

  // topic 2 is authored by the stub session (u1) → inline editor flow
  await browserPage.evaluate(() => { location.hash = "#topico-2"; });
  await new Promise(r2 => setTimeout(r2, 400));
  const own = await browserPage.evaluate(() => ({
    edit: !!document.querySelector("#threadMount .op [data-edit]"),
    del: !!document.querySelector("#threadMount [data-del]")
  }));
  log("forum edit button on own topic", own.edit && own.del, JSON.stringify(own));

  await browserPage.click("#threadMount .op [data-edit]");
  await new Promise(r2 => setTimeout(r2, 300));
  const ed0 = await browserPage.evaluate(() => {
    const ta = document.querySelector("#threadMount .op [data-editta]");
    return {
      ta: !!ta,
      val: ta ? ta.value : "",
      save: !!document.querySelector("[data-editsave]"),
      cancel: !!document.querySelector("[data-editcancel]")
    };
  });
  log("forum edit opens textarea with content",
    ed0.ta && ed0.val.indexOf("Lê antes de publicar") === 0, JSON.stringify(ed0));

  await browserPage.evaluate(() => {
    const ta = document.querySelector("#threadMount .op [data-editta]");
    ta.value = "Conteudo editado pelo gate";
    ta.dispatchEvent(new Event("input"));
  });
  await browserPage.click("#threadMount [data-editsave]");
  await new Promise(r2 => setTimeout(r2, 500));
  const ed1 = await browserPage.evaluate(() => ({
    body: (document.querySelector("#threadMount .op .pbody") || {}).textContent || "",
    taGone: !document.querySelector("#threadMount [data-editta]"),
    toast: (document.getElementById("eclToasts") || {}).textContent || ""
  }));
  log("forum edit saves (stub post_edit)",
    ed1.body === "Conteudo editado pelo gate" && ed1.taGone &&
      /editada/.test(ed1.toast),
    JSON.stringify(ed1));

  // create form moved out of the forum (admin panel only)
  await open(browserPage, "forum.html", 1440, 900);
  await new Promise(r2 => setTimeout(r2, 700));
  const moved = await browserPage.evaluate(() => ({
    noCreateWrap: !document.getElementById("createWrap"),
    noScForm: !document.getElementById("scForm"),
    noScRestrict: !document.getElementById("scRestrict"),
    homeRows: document.querySelectorAll("#homeRows tr").length
  }));
  log("forum create form moved to admin",
    moved.noCreateWrap && moved.noScForm && moved.noScRestrict && moved.homeRows >= 2,
    JSON.stringify(moved));
  await browserPage.screenshot({ path: path.join(OUT, "forum-home-" + THEME + ".png"), fullPage: false });

  } finally {
    // cleanup: back to anonymous for later blocks
    await browserPage.evaluate(() => localStorage.removeItem("ecl-session"));
    browserPage.off("request", onReq);
    await browserPage.setRequestInterception(false);
  }
}

// 4. teacher: known id=1
{
  const errs = await open(browserPage, "teacher.html?id=1", 1440, 900);
  const r = await browserPage.evaluate(() => ({
    content: !document.getElementById("content").classList.contains("hide"),
    name: (document.getElementById("tName")||{}).textContent || "",
    stars: document.querySelectorAll(".stars span").length,
    rateGate: !document.getElementById("rateGate").classList.contains("hide"),
    rateFormHidden: document.getElementById("rateForm").classList.contains("hide"),
    acctLogin: ((document.getElementById("acct")||{}).innerHTML||"").includes("auth.html?next=")
  }));
  log("teacher load", r.content && r.name.length > 0, JSON.stringify(r));
  log("teacher rate gate (anon)", r.rateGate && r.rateFormHidden && r.acctLogin, JSON.stringify(r));

  // M4: rating histogram (visible when ratings exist) + comment sort controls
  const h = await browserPage.evaluate(() => {
    const card = document.getElementById("histCard");
    const rows = document.querySelectorAll("#tHist .hrow");
    let sum = 0;
    rows.forEach(row => {
      row.querySelectorAll(".hcount").forEach(c => { sum += Number(c.textContent) || 0; });
    });
    return {
      hidden: card.classList.contains("hide"),
      rows: rows.length,
      sum: sum,
      labels: Array.from(document.querySelectorAll("#tHist .hlabel")).map(l => l.textContent).join(",")
    };
  });
  log("teacher histogram",
    h.hidden ? h.rows === 0 : (h.rows === 4 && h.sum >= 1 &&
      h.labels === "Clareza,Apoio,Justiça,Média"),
    JSON.stringify(h));

  const cs = await browserPage.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("#cmSort .sortbtn"));
    const dates = Array.from(document.querySelectorAll("#comments .cm .meta")).map(m => m.textContent);
    return {
      btns: btns.length,
      on: (btns.find(b => b.classList.contains("on")) || {}).dataset?.csort,
      pressed: (btns.find(b => b.getAttribute("aria-pressed") === "true") || {}).dataset?.csort,
      cms: document.querySelectorAll("#comments .cm").length,
      firstTxt: ((document.querySelector("#comments .cm .txt") || {}).textContent || "").slice(0, 40)
    };
  });
  log("teacher comment sort default",
    cs.btns === 3 && cs.on === "new" && cs.pressed === "new",
    JSON.stringify({ btns: cs.btns, on: cs.on, pressed: cs.pressed, cms: cs.cms }));

  await browserPage.click('#cmSort [data-csort="old"]');
  await new Promise(r2 => setTimeout(r2, 150));
  const csOld = await browserPage.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("#cmSort .sortbtn"));
    return {
      on: (btns.find(b => b.classList.contains("on")) || {}).dataset?.csort,
      pressed: (btns.find(b => b.getAttribute("aria-pressed") === "true") || {}).dataset?.csort,
      firstTxt: ((document.querySelector("#comments .cm .txt") || {}).textContent || "").slice(0, 40)
    };
  });
  log("teacher comment sort antigos",
    csOld.on === "old" && csOld.pressed === "old" &&
      (cs.cms < 2 || csOld.firstTxt !== cs.firstTxt),
    JSON.stringify(csOld));

  await browserPage.click('#cmSort [data-csort="best"]');
  await new Promise(r2 => setTimeout(r2, 150));
  const csBest = await browserPage.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("#cmSort .sortbtn"));
    return {
      on: (btns.find(b => b.classList.contains("on")) || {}).dataset?.csort,
      pressed: (btns.find(b => b.getAttribute("aria-pressed") === "true") || {}).dataset?.csort
    };
  });
  log("teacher comment sort melhores",
    csBest.on === "best" && csBest.pressed === "best",
    JSON.stringify(csBest));

  log("teacher no page errors", errs.length === 0, errs.join("; "));
}

// 4b. perfil: public profile page (stubbed)
{
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Expose-Headers": "*"
  };
  const pProfiles = [
    { id: "u1", username: "gate", role: "owner", country: null,
      muted_until: null, banned: false, created_at: "2026-01-01T00:00:00Z" },
    { id: "u2", username: "ana", role: "user", country: "PT",
      muted_until: "2099-01-01T00:00:00Z", banned: false,
      created_at: "2026-02-02T00:00:00Z" }
  ];
  const pRatings = [
    { id: 21, teacher_id: 1, user_id: "u1", clareza: 5, apoio: 4, justica: 3,
      comment: "Boa explicação", created_at: "2026-10-09T09:00:00Z" },
    { id: 22, teacher_id: 2, user_id: "u1", clareza: 2, apoio: 2, justica: 5,
      comment: "", created_at: "2026-10-08T09:00:00Z" }
  ];
  const pTeachers = [
    { id: 1, name: "Helga Duarte", subject: "Matemática" },
    { id: 2, name: "Professor 2", subject: "Disciplina 2" }
  ];
  const onReq = req => {
    const u = req.url();
    const json = body => req.respond({ status: 200, headers: CORS, contentType: "application/json", body });
    if(u.includes("/rest/v1/profiles")) return json(JSON.stringify(pProfiles));
    if(u.includes("/rest/v1/ratings"))
      return json(JSON.stringify(u.includes("user_id=eq.u2") ? [] : pRatings));
    if(u.includes("/rest/v1/teachers")) return json(JSON.stringify(pTeachers));
    if(u.includes("/rest/v1/rpc/")) return json(JSON.stringify({ count: 0 }));
    return req.continue();
  };
  await browserPage.evaluate(() => localStorage.removeItem("ecl-session"));
  await browserPage.setRequestInterception(true);
  browserPage.on("request", onReq);
  try {
    // public view (anon): u1 owner with 2 ratings
    const errs = await open(browserPage, "perfil.html?id=u1", 1440, 900);
    const pf = await browserPage.evaluate(() => ({
      content: !document.getElementById("content").classList.contains("hide"),
      name: (document.getElementById("pfName")||{}).textContent || "",
      badge: /OWNER/.test((document.getElementById("pfBadge")||{}).textContent || ""),
      since: /Membro desde/.test((document.getElementById("pfSince")||{}).textContent || ""),
      stats: (document.getElementById("pfStats")||{}).textContent || "",
      rows: document.querySelectorAll("#pfList .cm").length,
      teacherLinks: document.querySelectorAll('#pfList a[href^="teacher.html"]').length,
      ownHidden: document.getElementById("pfOwn").classList.contains("hide"),
      chipsHidden: document.getElementById("pfChips").classList.contains("hide")
    }));
    log("perfil public view",
      pf.content && pf.name === "gate" && pf.badge && pf.since &&
        pf.rows === 2 && pf.teacherLinks === 2 && pf.ownHidden && pf.chipsHidden &&
        /2 avaliações/.test(pf.stats) && /1 com comentário/.test(pf.stats),
      JSON.stringify(pf));
    log("perfil no page errors", errs.length === 0, errs.join("; "));

    // own view (session u2): "Gerir conta" shown + mute chip
    await browserPage.evaluate(() => localStorage.setItem("ecl-session", JSON.stringify({
      token: "gate-fake",
      exp: Math.floor(Date.now() / 1000) + 3600,
      username: "ana",
      role: "user",
      id: "u2"
    })));
    const errs2 = await open(browserPage, "perfil.html?id=u2", 1440, 900);
    const own = await browserPage.evaluate(() => ({
      name: (document.getElementById("pfName")||{}).textContent || "",
      ownShown: !document.getElementById("pfOwn").classList.contains("hide"),
      manage: !!document.querySelector('#pfOwn a[href="conta.html"]'),
      chipsShown: !document.getElementById("pfChips").classList.contains("hide"),
      muted: /Silenciado até/.test((document.getElementById("pfChips")||{}).textContent || ""),
      empty: /Ainda não há avaliações/.test((document.getElementById("pfList")||{}).textContent || "")
    }));
    log("perfil own view + mute chip",
      own.name === "ana" && own.ownShown && own.manage &&
        own.chipsShown && own.muted && own.empty,
      JSON.stringify(own));
    log("perfil own no page errors", errs2.length === 0, errs2.join("; "));

    // missing profile
    await browserPage.evaluate(() => localStorage.removeItem("ecl-session"));
    const errs3 = await open(browserPage, "perfil.html?id=zzz", 1440, 900);
    const miss = await browserPage.evaluate(() => ({
      missing: !document.getElementById("missing").classList.contains("hide"),
      contentHidden: document.getElementById("content").classList.contains("hide")
    }));
    log("perfil missing profile", miss.missing && miss.contentHidden, JSON.stringify(miss));
    log("perfil missing no page errors", errs3.length === 0, errs3.join("; "));

    // entry links from teacher comments (errors covered by section 4 live run)
    await browserPage.setViewport({ width: 1440, height: 900 });
    await browserPage.goto(
      "file:///" + path.join(BASE, "teacher.html").replace(/\\/g, "/") + "?id=1",
      { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise(r2 => setTimeout(r2, 3500));
    const elinks = await browserPage.evaluate(() => ({
      cms: document.querySelectorAll("#comments .cm").length,
      links: document.querySelectorAll('#comments .who a[href^="perfil.html"]').length
    }));
    log("teacher comments link to perfil",
      elinks.cms === 0 || elinks.links >= 1, JSON.stringify(elinks));

    // mobile overflow (current page: teacher entry)
    await browserPage.setViewport({ width: 390, height: 844 });
    await new Promise(r2 => setTimeout(r2, 250));
    const mov = await browserPage.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth
    }));
    log("teacher entry mobile no overflow", mov.sw <= mov.iw, JSON.stringify(mov));
    await browserPage.setViewport({ width: 1440, height: 900 });
  } finally {
    browserPage.off("request", onReq);
    await browserPage.setRequestInterception(false);
    await browserPage.evaluate(() => localStorage.removeItem("ecl-session"));
  }
}

// 5. auth: modes + underline tabs + live checklist + no-reset + inline errors
{
  const errs = await open(browserPage, "auth.html?next=top.html", 1440, 900);
  const r = await browserPage.evaluate(() => {
    const ml = document.getElementById("modeLogin");
    const cs = getComputedStyle(ml);
    return {
      modeLogin: ml.classList.contains("on"),
      btn: (document.getElementById("auBtn")||{}).textContent || "",
      cfgHidden: document.getElementById("cfgWarn").classList.contains("hide"),
      tabRadius: cs.borderRadius,
      tabBorder: cs.borderBottomWidth,
      tabBorderOn: cs.borderBottomColor,
      rulesShown: getComputedStyle(document.getElementById("auRules")).display !== "none",
      lenShown: getComputedStyle(document.querySelector('[data-rule="len"]')).display !== "none",
      matchHidden: document.querySelector('[data-rule="match"]').classList.contains("hide"),
      warn: (document.body.textContent || "").includes("Não há recuperação por email")
    };
  });
  log("auth login mode", r.modeLogin && r.btn === "Entrar" && r.cfgHidden, JSON.stringify(r));
  log("auth underline tabs", r.tabRadius === "0px" && r.tabBorder === "2px" && r.tabBorderOn !== "rgba(0, 0, 0, 0)" && r.tabBorderOn !== "transparent",
    JSON.stringify({ radius: r.tabRadius, border: r.tabBorder, color: r.tabBorderOn }));
  log("auth checklist + no-reset warn", r.rulesShown && r.lenShown && r.matchHidden && r.warn, JSON.stringify(r));

  // live len rule: short then valid password
  await browserPage.evaluate(() => { const p = document.getElementById("auPass"); p.value = ""; p.dispatchEvent(new Event("input")); });
  await browserPage.type("#auPass", "abc");
  await new Promise(r2 => setTimeout(r2, 100));
  const short = await browserPage.evaluate(() => document.querySelector('[data-rule="len"]').classList.contains("ok"));
  await browserPage.evaluate(() => { const p = document.getElementById("auPass"); p.value = ""; p.dispatchEvent(new Event("input")); });
  await browserPage.type("#auPass", "abcdefgh");
  await new Promise(r2 => setTimeout(r2, 100));
  const valid = await browserPage.evaluate(() => document.querySelector('[data-rule="len"]').classList.contains("ok"));
  log("auth live len rule", !short && valid, JSON.stringify({ short, valid }));

  // switch mode
  await browserPage.click("#modeReg");
  await new Promise(r2 => setTimeout(r2, 200));
  const reg = await browserPage.evaluate(() => ({
    btn: (document.getElementById("auBtn")||{}).textContent || "",
    pass2: !document.getElementById("auPass2").classList.contains("hide"),
    matchShown: !document.querySelector('[data-rule="match"]').classList.contains("hide")
  }));
  log("auth reg mode", reg.btn === "Criar conta" && reg.pass2 && reg.matchShown, JSON.stringify(reg));

  // live match rule
  await browserPage.type("#auPass2", "abcdefgh");
  await new Promise(r2 => setTimeout(r2, 100));
  const matchOk = await browserPage.evaluate(() => document.querySelector('[data-rule="match"]').classList.contains("ok"));
  await browserPage.evaluate(() => { const p = document.getElementById("auPass2"); p.value = "zzzz"; p.dispatchEvent(new Event("input")); });
  await new Promise(r2 => setTimeout(r2, 100));
  const matchBad = await browserPage.evaluate(() => document.querySelector('[data-rule="match"]').classList.contains("ok"));
  log("auth live match rule", matchOk && !matchBad, JSON.stringify({ matchOk, matchBad }));

  // invalid username: inline error, inputs preserved
  await browserPage.evaluate(() => { const u = document.getElementById("auUser"); u.value = "x"; u.dispatchEvent(new Event("input")); });
  await browserPage.click("#auBtn");
  await new Promise(r2 => setTimeout(r2, 300));
  const err = await browserPage.evaluate(() => ({
    msg: (document.getElementById("auMsg")||{}).textContent || "",
    user: (document.getElementById("auUser")||{}).value || "",
    pass: (document.getElementById("auPass")||{}).value || ""
  }));
  log("auth inline error keeps input", err.msg.length > 0 && err.user === "x" && err.pass === "abcdefgh", JSON.stringify(err));
  log("auth no page errors", errs.length === 0, errs.join("; "));
}

// 6. conta: redirect anon + edit flow (stub session, stubbed API)
{
  await browserPage.setViewport({ width: 1440, height: 900 });
  const url = fileUrl(path.join(BASE, "conta.html"));
  await browserPage.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise(r => setTimeout(r, 2500));
  const loc = browserPage.url();
  log("conta redirects anon", loc.includes("auth.html"), loc);

  await browserPage.evaluate(() => localStorage.setItem("ecl-session", JSON.stringify({
    token: "gate-fake",
    exp: Math.floor(Date.now() / 1000) + 3600,
    username: "gate",
    role: "user",
    id: "u1",
    created_at: "2026-01-05T00:00:00Z"
  })));

  let updCalled = false;
  let updBody = null;
  let ctvCalled = false;
  let ctvBody = null;
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Expose-Headers": "*"
  };
  const onReq = req => {
    const u = req.url();
    if(u.includes("/rest/v1/teachers")){
      req.respond({ status: 200, headers: CORS, contentType: "application/json",
        body: JSON.stringify([{ id: 1, name: "Helga Duarte", subject: "Matemática", branch: "CFE-1" }]) });
    } else if(u.includes("/rest/v1/profiles")){
      req.respond({ status: 200, headers: CORS, contentType: "application/json",
        body: JSON.stringify([{ id: "u1", username: "gate", role: "user", country: "PT" }]) });
    } else if(u.includes("/rpc/my_ratings")){
      req.respond({ status: 200, headers: CORS, contentType: "application/json",
        body: JSON.stringify([{ id: 7, teacher_id: 1, clareza: 4, apoio: 5, justica: 3,
          comment: "Bom professor", created_at: "2026-10-10T10:00:00.000Z" }]) });
    } else if(u.includes("/rpc/rating_update")){
      updCalled = true;
      updBody = req.postData();
      req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({}) });
    } else if(u.includes("/rpc/user_set_country")){
      ctvCalled = true;
      ctvBody = req.postData();
      req.respond({ status: 200, headers: CORS, contentType: "application/json",
        body: JSON.stringify({ country: "FR" }) });
    } else if(u.includes("/rpc/logout")){
      req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({}) });
    } else {
      req.continue();
    }
  };
  await browserPage.setRequestInterception(true);
  browserPage.on("request", onReq);

  try {
    const errs = await open(browserPage, "conta.html", 1440, 900);
    const r = await browserPage.evaluate(() => ({
      name: (document.getElementById("cName")||{}).textContent || "",
      rows: document.querySelectorAll(".mrow").length,
      meta: (document.querySelector(".mrow .meta")||{}).textContent || "",
      cmt: (document.querySelector(".mrow .cmt")||{}).textContent || ""
    }));
    log("conta session + rows", r.name === "gate" && r.rows === 1 && /Clareza 4/.test(r.meta) && r.cmt === "Bom professor", JSON.stringify(r));
    log("conta row date", /10\/10\/2026/.test(r.meta), r.meta);

    // open edit: score inputs populated (scores now editable)
    await browserPage.click('[data-edit-btn="7"]');
    await new Promise(r2 => setTimeout(r2, 250));
    const ed = await browserPage.evaluate(() => {
      const c = document.querySelector('[data-rid="7"][data-sc="c"]');
      const a = document.querySelector('[data-rid="7"][data-sc="a"]');
      const j = document.querySelector('[data-rid="7"][data-sc="j"]');
      const ta = document.querySelector('[data-edit="7"]');
      return {
        has: !!(c && a && j && ta),
        c: c ? c.value : "", a: a ? a.value : "", j: j ? j.value : "",
        ta: ta ? ta.value : ""
      };
    });
    log("conta edit scores enabled", ed.has && ed.c === "4" && ed.a === "5" && ed.j === "3" && ed.ta === "Bom professor", JSON.stringify(ed));

    // invalid score → inline error, no rpc fired
    await browserPage.evaluate(() => {
      const c = document.querySelector('[data-rid="7"][data-sc="c"]');
      c.value = "9";
      c.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browserPage.click('[data-save="7"]');
    await new Promise(r2 => setTimeout(r2, 300));
    const bad = await browserPage.evaluate(() => ({
      msg: (document.querySelector('[data-msg="7"]')||{}).textContent || "",
      stillOpen: !!document.querySelector('[data-rid="7"][data-sc="c"]')
    }));
    log("conta score validation", /1 e 5/.test(bad.msg) && bad.stillOpen && !updCalled, JSON.stringify({ bad, updCalled }));

    // valid save → identical payload shape, edit closes, toast
    await browserPage.evaluate(() => {
      const c = document.querySelector('[data-rid="7"][data-sc="c"]');
      c.value = "3";
      c.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browserPage.click('[data-save="7"]');
    await new Promise(r2 => setTimeout(r2, 600));
    let body = null;
    try { body = updBody ? JSON.parse(updBody) : null; } catch(e) {}
    const saved = await browserPage.evaluate(() => ({
      closed: !document.querySelector('[data-rid="7"][data-sc="c"]'),
      meta: (document.querySelector(".mrow .meta")||{}).textContent || "",
      toast: !!document.querySelector("#eclToasts .toast")
    }));
    log("conta save payload",
      updCalled && body && body.p_id === 7 && body.p_clareza === 3 && body.p_apoio === 5 && body.p_justica === 3 && body.p_comment === "Bom professor" && body.p_token === "gate-fake",
      JSON.stringify({ updCalled, body }));
    log("conta edit closes + toast", saved.closed && /Clareza 3/.test(saved.meta) && saved.toast, JSON.stringify(saved));

    // country picker: preselected from own profile row + preview flag
    const ctv = await browserPage.evaluate(() => {
      const sel = document.getElementById("cCountry");
      const prev = document.querySelector("#cFlagPrev .flag");
      return {
        sel: !!sel,
        opts: sel ? sel.options.length : 0,
        val: sel ? sel.value : "",
        prev: !!prev,
        prevSrc: prev ? prev.src : ""
      };
    });
    log("conta country picker",
      ctv.sel && ctv.opts > 200 && ctv.val === "PT" && ctv.prev &&
        /flagcdn\.com\/20x15\/pt\.png/.test(ctv.prevSrc),
      JSON.stringify(ctv));

    // country save → user_set_country payload + preview updates
    await browserPage.evaluate(() => {
      const sel = document.getElementById("cCountry");
      sel.value = "FR";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await browserPage.click("#cCountrySave");
    await new Promise(r2 => setTimeout(r2, 500));
    let ctvBodyObj = null;
    try { ctvBodyObj = ctvBody ? JSON.parse(ctvBody) : null; } catch(e) {}
    const ctvSaved = await browserPage.evaluate(() => ({
      toast: !!document.querySelector("#eclToasts .toast"),
      prevSrc: (document.querySelector("#cFlagPrev .flag")||{}).src || ""
    }));
    log("conta country save payload",
      ctvCalled && ctvBodyObj && ctvBodyObj.p_country === "FR" &&
        ctvBodyObj.p_token === "gate-fake" && ctvSaved.toast &&
        /flagcdn\.com\/20x15\/fr\.png/.test(ctvSaved.prevSrc),
      JSON.stringify({ ctvCalled, ctvBodyObj, ctvSaved }));

    // profile theme switch (claro/escuro)
    const pth = await browserPage.evaluate(async () => {
      const btns = Array.from(document.querySelectorAll("[data-themeswitch]"));
      const doc = document.documentElement;
      const cur = doc.getAttribute("data-theme") ||
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const other = cur === "dark" ? "light" : "dark";
      const otherBtn = btns.find(b => b.getAttribute("data-themeswitch") === other);
      if(!otherBtn) return { has: false, count: btns.length };
      otherBtn.click();
      await new Promise(r => setTimeout(r, 120));
      const out = {
        has: true, cur: cur, count: btns.length,
        pressed: otherBtn.getAttribute("aria-pressed"),
        cls: otherBtn.classList.contains("on"),
        attr: doc.getAttribute("data-theme"),
        stored: localStorage.getItem("ecl-theme")
      };
      const back = document.querySelector('[data-themeswitch="' + cur + '"]');
      if(back) back.click();
      await new Promise(r => setTimeout(r, 80));
      return out;
    });
    log("conta theme switch claro/escuro",
      pth.has && pth.count === 2 && pth.pressed === "true" && pth.cls &&
        (pth.attr === "light" || pth.attr === "dark") && pth.stored === pth.attr,
      JSON.stringify(pth));

    log("conta no page errors", errs.length === 0, errs.join("; "));
  } finally {
    browserPage.off("request", onReq);
    await browserPage.setRequestInterception(false);
    await browserPage.evaluate(() => localStorage.removeItem("ecl-session"));
  }
}

// 7. admin: login screen (anon) + full panel flow (stub session + stubbed API)
{
  // anonymous login screen
  const errs0 = await open(browserPage, "admin.html", 1440, 900);
  const anon = await browserPage.evaluate(() => ({
    login: !document.getElementById("loginScreen").classList.contains("hidden"),
    adminHidden: document.getElementById("adminScreen").classList.contains("hidden"),
    btn: !!document.getElementById("loginBtn")
  }));
  log("admin login screen",     anon.login && anon.adminHidden && anon.btn, JSON.stringify(anon));
  log("admin anon no page errors", errs0.length === 0, errs0.join("; "));

  // establish origin, then inject owner session
  await browserPage.evaluate(() => localStorage.setItem("ecl-session", JSON.stringify({
    token: "gate-fake",
    exp: Math.floor(Date.now() / 1000) + 3600,
    username: "gate",
    role: "owner",
    id: "u1",
    created_at: "2026-01-01T00:00:00Z"
  })));

  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Expose-Headers": "*"
  };
  const stubTeachers = [{ id: 1, name: "Helga Duarte", subject: "Matemática" }];
  for(let i = 2; i <= 30; i++) stubTeachers.push({ id: i, name: "Professor " + i, subject: "Disciplina " + (i % 4) });
  const stubRatings = [
    { id: 11, teacher_id: 1, user_id: "u2", clareza: 5, apoio: 5, justica: 3, comment: "Excelente", created_at: "2026-10-10T10:00:00Z" },
    { id: 12, teacher_id: 2, user_id: null, clareza: 4, apoio: 4, justica: 4, comment: "", created_at: "2026-10-11T10:00:00Z" }
  ];
  const stubForum = [
    { id: 1, parent_id: null, title: "Dúvida sobre horários", content: "Conteúdo do tópico", author_name: "Ana", user_id: "u2", teacher_id: 1, branch_id: null, created_at: "2026-10-12T10:00:00Z" }
  ];
  const stubBranches = [
    { id: 5, name: "Sala dos Professores", access_view: "all", access_publish: "user", access_reply: "user", created_at: "2026-10-12T09:00:00Z" }
  ];
  const stubProfiles = [
    { id: "u1", username: "gate", role: "owner" },
    { id: "u2", username: "ana", role: "user",
      muted_until: "2099-01-01T00:00:00Z", banned: false }
  ];
  const stubAudit = [
    { id: 2, ts: "2026-10-13T10:05:00Z", actor: "gate", action: "user_set_role",
      target: "u2", detail: { username: "ana", role: "moderator" } },
    { id: 1, ts: "2026-10-12T10:00:00Z", actor: "ana", action: "post_edit",
      target: "1", detail: { chars: 42 } }
  ];
  const sessionData = {
    token: "gate-fake", exp: Math.floor(Date.now() / 1000) + 3600,
    username: "gate", role: "owner", id: "u1", created_at: "2026-01-01T00:00:00Z"
  };
  const rpcCalls = null; // payload capture moved to in-page sb.rpc spy
  const onReq = req => {
    const u = req.url();
    const json = body => req.respond({ status: 200, headers: CORS, contentType: "application/json", body });
    if(u.includes("/rest/v1/teachers")) return json(JSON.stringify(stubTeachers));
    if(u.includes("/rest/v1/ratings")) return json(JSON.stringify(stubRatings));
    if(u.includes("/rest/v1/forum_posts")) return json(JSON.stringify(stubForum));
    if(u.includes("/rest/v1/profiles")) return json(JSON.stringify(stubProfiles));
    if(u.includes("/rest/v1/rpc/")){
      const fn = u.split("/rpc/")[1].split("?")[0];
      if(fn === "session_info" || fn === "login") return json(JSON.stringify(sessionData));
      if(fn === "forum_feed") return json(JSON.stringify({ branches: stubBranches, posts: stubForum }));
      if(fn === "mod_log_list") return json(JSON.stringify({ rows: stubAudit }));
      return json(JSON.stringify({}));
    }
    return req.continue();
  };
  await browserPage.setRequestInterception(true);
  browserPage.on("request", onReq);

  const rpcCount = fn => browserPage.evaluate(
    f => (window.__rpcLog || []).filter(c => c.fn === f).length, fn
  );
  const rpcArg = (fn, i) => browserPage.evaluate(
    (f, idx) => {
      const hits = (window.__rpcLog || []).filter(c => c.fn === f);
      return hits.length > idx ? JSON.parse(JSON.stringify(hits[idx].args)) : null;
    }, fn, i || 0
  );

  try {
    const errs = await open(browserPage, "admin.html", 1440, 900);
    // spy on sb.rpc (admin script is global-scope; sb resolves via window at call time)
    await browserPage.evaluate(() => {
      window.__rpcLog = [];
      if(window.sb && window.sb.rpc){
        const orig = window.sb.rpc.bind(window.sb);
        window.sb.rpc = function(fn, args){
          window.__rpcLog.push({ fn: fn, args: args });
          return orig(fn, args);
        };
      }
    });
    const panel = await browserPage.evaluate(() => ({
      admin: !document.getElementById("adminScreen").classList.contains("hidden"),
      loginHidden: document.getElementById("loginScreen").classList.contains("hidden"),
      noPermsHidden: document.getElementById("noPerms").classList.contains("hide"),
      tabs: document.querySelectorAll(".tab").length,
      tabsVisible: getComputedStyle(document.querySelector(".tabs")).display !== "none",
      stats: [
        document.getElementById("statTeachers").textContent,
        document.getElementById("statRatings").textContent,
        document.getElementById("statComments").textContent,
        document.getElementById("statForum").textContent
      ]
    }));
    log("admin panel enters (owner)",
      panel.admin && panel.loginHidden && panel.noPermsHidden && panel.tabs === 8 && panel.tabsVisible,
      JSON.stringify(panel));
    log("admin stats", panel.stats.join(",") === "30,2,1,1", panel.stats.join(","));

    // open teachers tab before table checks
    await browserPage.click('[onclick*="openTab(\'teachers\'"]');
    await new Promise(r => setTimeout(r, 300));

    // teachers table + sticky header
    const t = await browserPage.evaluate(() => {
      const w = document.querySelector("#teacherList .twrap");
      const ths = document.querySelectorAll("#teacherList thead th");
      const rows = document.querySelectorAll("#teacherList tbody tr");
      let sticky = null;
      if(w){
        w.scrollTop = 200;
        const wr = w.getBoundingClientRect();
        const tr = w.querySelector("thead th").getBoundingClientRect();
        sticky = { diff: Math.round(tr.top - wr.top), scrolled: w.scrollTop, scrollable: w.scrollHeight > w.clientHeight };
        w.scrollTop = 0;
      }
      return { wrap: !!w, ths: ths.length, rows: rows.length, sticky };
    });
    log("admin teachers table", t.wrap && t.ths === 4 && t.rows === 30, JSON.stringify(t));
    log("admin sticky header", t.sticky && t.sticky.scrollable && t.sticky.scrolled === 200 && Math.abs(t.sticky.diff) <= 1, JSON.stringify(t.sticky));

    // search filter
    await browserPage.type("#teacherSearch", "professor");
    await new Promise(r => setTimeout(r, 250));
    const filtered = await browserPage.evaluate(() => document.querySelectorAll("#teacherList tbody tr").length);
    await browserPage.evaluate(() => {
      const el = document.getElementById("teacherSearch");
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 250));
    log("admin teachers search", filtered === 29, String(filtered));

    // inline teacher edit (was prompt)
    await browserPage.click('[onclick^="editTeacher(1)"]');
    await new Promise(r => setTimeout(r, 250));
    const ed = await browserPage.evaluate(() => ({
      name: (document.getElementById("tname-1") || {}).value || "",
      sub: (document.getElementById("tsub-1") || {}).value || ""
    }));
    log("admin teacher edit inline", ed.name === "Helga Duarte" && ed.sub === "Matemática", JSON.stringify(ed));
    await browserPage.evaluate(() => { document.getElementById("tname-1").value = "Helga Duarte Jr"; });
    await browserPage.click('[onclick^="saveTeacher(1)"]');
    await new Promise(r => setTimeout(r, 400));
    const tuBody = await rpcArg("teacher_update");
    const afterSave = await browserPage.evaluate(() => ({
      closed: !document.getElementById("tname-1"),
      toast: ((document.querySelector("#eclToasts .toast") || {}).textContent || "")
    }));
    log("admin teacher save payload",
      tuBody && tuBody.p_id === 1 && tuBody.p_name === "Helga Duarte Jr" && tuBody.p_subject === "Matemática" && tuBody.p_token === "gate-fake",
      JSON.stringify(tuBody));
    log("admin teacher edit closes + toast", afterSave.closed && /atualizado/.test(afterSave.toast), JSON.stringify(afterSave));

    // ratings tab: table + inline score inputs (was prompt)
    await browserPage.click('[onclick*="openTab(\'ratings\'"]');
    await new Promise(r => setTimeout(r, 300));
    const rt = await browserPage.evaluate(() => ({
      wide: !!document.querySelector("#ratingList .tbl.wide"),
      rows: document.querySelectorAll("#ratingList tbody tr").length,
      c: (document.querySelector('[data-rid="11"][data-sc="c"]') || {}).value,
      a: (document.querySelector('[data-rid="11"][data-sc="a"]') || {}).value,
      j: (document.querySelector('[data-rid="11"][data-sc="j"]') || {}).value,
      ta: (document.getElementById("comment-11") || {}).value
    }));
    log("admin ratings table + inputs", rt.wide && rt.rows === 2 && rt.c === "5" && rt.a === "5" && rt.j === "3" && rt.ta === "Excelente", JSON.stringify(rt));

    // invalid score → err toast, no rpc
    await browserPage.evaluate(() => {
      document.querySelector('[data-rid="11"][data-sc="c"]').value = "9";
    });
    await browserPage.click('[onclick^="saveRating(11)"]');
    await new Promise(r => setTimeout(r, 300));
    const bad = await browserPage.evaluate(() => ({
      err: !!document.querySelector("#eclToasts .toast.err"),
      still: !!document.querySelector('[data-rid="11"][data-sc="c"]')
    }));
    log("admin score validation", bad.err && bad.still && (await rpcCount("rating_update")) === 0, JSON.stringify({ bad, calls: await rpcCount("rating_update") }));

    // valid save → identical payload
    await browserPage.evaluate(() => {
      document.querySelector('[data-rid="11"][data-sc="c"]').value = "4";
    });
    await browserPage.click('[onclick^="saveRating(11)"]');
    await new Promise(r => setTimeout(r, 400));
    const ruBody = await rpcArg("rating_update");
    log("admin rating save payload",
      ruBody && ruBody.p_id === 11 && ruBody.p_clareza === 4 && ruBody.p_apoio === 5 && ruBody.p_justica === 3 && ruBody.p_comment === "Excelente" && ruBody.p_token === "gate-fake",
      JSON.stringify(ruBody));

    // delete dialog (was confirm): cancel does nothing, confirm fires rpc
    await browserPage.click('[onclick^="deleteRating(11)"]');
    await new Promise(r => setTimeout(r, 200));
    const dlg1 = await browserPage.evaluate(() => {
      const d = document.querySelector("dialog.ecl-dialog");
      return { open: !!d && d.open, ok: !!document.querySelector("dialog.ecl-dialog .ecl-ok") };
    });
    log("admin delete dialog", dlg1.open && dlg1.ok, JSON.stringify(dlg1));
    await browserPage.click("dialog.ecl-dialog .ecl-no");
    await new Promise(r => setTimeout(r, 250));
    const cancelled = await browserPage.evaluate(() => !document.querySelector("dialog.ecl-dialog"));
    log("admin dialog cancel", cancelled && (await rpcCount("rating_delete")) === 0, JSON.stringify({ cancelled, calls: await rpcCount("rating_delete") }));

    await browserPage.click('[onclick^="deleteRating(11)"]');
    await new Promise(r => setTimeout(r, 200));
    await browserPage.click("dialog.ecl-dialog .ecl-ok");
    await new Promise(r => setTimeout(r, 400));
    const rdBody = await rpcArg("rating_delete");
    log("admin delete confirm", rdBody && rdBody.p_id === 11, JSON.stringify(rdBody));

    // forum tab: table + confirm flow
    await browserPage.click('[onclick*="openTab(\'forumTab\'"]');
    await new Promise(r => setTimeout(r, 300));
    const ft = await browserPage.evaluate(() => ({
      rows: document.querySelectorAll("#forumList tbody tr").length,
      open: !!document.querySelector('#forumList [onclick*="forum.html#topico-1"]')
    }));
    log("admin forum table", ft.rows === 1 && ft.open, JSON.stringify(ft));
    await browserPage.click('#forumList [onclick^="deleteForumPost(1)"]');
    await new Promise(r => setTimeout(r, 200));
    await browserPage.click("dialog.ecl-dialog .ecl-ok");
    await new Promise(r => setTimeout(r, 400));
    const fdBody = await rpcArg("forum_delete");
    log("admin forum delete", fdBody && fdBody.p_id === 1, JSON.stringify(fdBody));

    // communities tab: access level selects + save payload
    await browserPage.click('[onclick*="openTab(\'branchesTab\'"]');
    await new Promise(r => setTimeout(r, 300));
    const br = await browserPage.evaluate(() => ({
      rows: document.querySelectorAll("#branchesList tbody tr").length,
      view: !!document.getElementById("bv5"),
      publish: !!document.getElementById("bp5"),
      reply: !!document.getElementById("brp5"),
      viewVal: (document.getElementById("bv5")||{}).value || "",
      publishVal: (document.getElementById("bp5")||{}).value || "",
      replyVal: (document.getElementById("brp5")||{}).value || ""
    }));
    log("admin communities table",
      br.rows === 1 && br.view && br.publish && br.reply &&
      br.viewVal === "all" && br.publishVal === "user" && br.replyVal === "user",
      JSON.stringify(br));
    await browserPage.evaluate(() => {
      document.getElementById("bv5").value = "user";
      document.getElementById("bp5").value = "moderator";
      document.getElementById("brp5").value = "media";
    });
    await browserPage.click('[onclick^="saveBranch(5)"]');
    await new Promise(r => setTimeout(r, 400));
    const baBody = await rpcArg("branch_access_update");
    log("admin communities save payload",
      baBody && baBody.p_id === 5 && baBody.p_view === "user" &&
      baBody.p_publish === "moderator" && baBody.p_reply === "media" &&
      baBody.p_token === "gate-fake",
      JSON.stringify(baBody));

    // create-community form (moved here from the forum)
    const cf = await browserPage.evaluate(() => ({
      name: !!document.getElementById("scName"),
      view: !!document.getElementById("scView"),
      publish: !!document.getElementById("scPublish"),
      reply: !!document.getElementById("scReply"),
      btn: !!document.getElementById("scSend"),
      viewOpts: (document.getElementById("scView") || { options: [] }).options.length
    }));
    log("admin create community form",
      cf.name && cf.view && cf.publish && cf.reply && cf.btn &&
      cf.viewOpts === 5,
      JSON.stringify(cf));
    await browserPage.type("#scName", "Comunidade Gate");
    await browserPage.click("#scSend");
    await new Promise(r => setTimeout(r, 600));
    const bcBody = await rpcArg("branch_create");
    const bcToast = await browserPage.evaluate(() =>
      /Comunidade criada/.test(document.body.textContent || ""));
    log("admin create community payload",
      bcBody && bcBody.p_name === "Comunidade Gate" && bcBody.p_view === "all" &&
      bcBody.p_publish === "user" && bcBody.p_reply === "user" &&
      bcBody.p_token === "gate-fake" && bcToast,
      JSON.stringify({ bcBody, bcToast }));
    await browserPage.screenshot({ path: path.join(OUT, "admin-communities-" + THEME + ".png"), fullPage: false });

    // users tab: select + guarded role change
    await browserPage.click('[onclick*="openTab(\'usersTab\'"]');
    await new Promise(r => setTimeout(r, 300));
    const ut = await browserPage.evaluate(() => ({
      rows: document.querySelectorAll("#usersList tbody tr").length,
      myLocked: !document.querySelector('#usersList [data-role-save="u1"]'),
      sel: !!document.querySelector('[data-role-sel="u2"]'),
      modBan: !!document.querySelector('#usersList [data-ban="u2"]'),
      modUnmute: !!document.querySelector('#usersList [data-unmute="u2"]'),
      modMute: !!document.querySelector('#usersList [data-mute="u2"]'),
      modSelf: !!document.querySelector('#usersList [data-ban="u1"]'),
      modChip: /Silenciado/.test(
        document.getElementById("usersList").textContent)
    }));
    log("admin users table",
      ut.rows === 2 && ut.myLocked && ut.sel &&
      ut.modBan && ut.modUnmute && !ut.modMute && !ut.modSelf && ut.modChip,
      JSON.stringify(ut));

    // moderation: unmute + ban payloads
    await browserPage.click('[data-unmute="u2"]');
    await new Promise(r => setTimeout(r, 200));
    await browserPage.click("dialog.ecl-dialog .ecl-ok");
    await new Promise(r => setTimeout(r, 400));
    const umBody = await rpcArg("user_unmute");
    log("admin users unmute payload",
      umBody && umBody.p_id === "u2" && umBody.p_token === "gate-fake",
      JSON.stringify(umBody));

    await browserPage.click('[data-ban="u2"]');
    await new Promise(r => setTimeout(r, 200));
    await browserPage.click("dialog.ecl-dialog .ecl-ok");
    await new Promise(r => setTimeout(r, 400));
    const banBody = await rpcArg("user_ban");
    log("admin users ban payload",
      banBody && banBody.p_id === "u2" && banBody.p_ban === true &&
      banBody.p_token === "gate-fake",
      JSON.stringify(banBody));
    await browserPage.evaluate(() => {
      document.querySelector('[data-role-sel="u2"]').value = "moderator";
    });
    await browserPage.click('[data-role-save="u2"]');
    await new Promise(r => setTimeout(r, 200));
    await browserPage.click("dialog.ecl-dialog .ecl-ok");
    await new Promise(r => setTimeout(r, 400));
    const urBody = await rpcArg("user_set_role");
    log("admin role change payload", urBody && urBody.p_id === "u2" && urBody.p_role === "moderator", JSON.stringify(urBody));

    // audit tab: rows from mod_log_list + CSV builder
    await browserPage.click('[onclick*="openTab(\'auditTab\'"]');
    await new Promise(r => setTimeout(r, 400));
    const au = await browserPage.evaluate(() => {
      const rows = document.querySelectorAll("#auditList tbody tr");
      const txt = document.getElementById("auditList").textContent || "";
      const csv = typeof buildAuditCsv === "function" ? buildAuditCsv() : "";
      const lines = csv.split("\r\n");
      return {
        rows: rows.length,
        who: /gate/.test(txt),
        action: /Cargo alterado/.test(txt),
        detail: /moderator/.test(txt),
        csvHeader: lines[0] || "",
        csvLines: lines.length,
        csvHasEdit: csv.indexOf("post_edit") >= 0,
        csvBtn: !!document.getElementById("auditCsvBtn")
      };
    });
    log("admin audit tab",
      au.rows === 2 && au.who && au.action && au.detail && au.csvBtn,
      JSON.stringify(au));
    log("admin audit csv",
      au.csvHeader === "id;data;ator;acao;alvo;detalhe" &&
        au.csvLines === 3 && au.csvHasEdit,
      JSON.stringify(au));

    // add teacher form
    await browserPage.click('[onclick*="openTab(\'addTeacher\'"]');
    await new Promise(r => setTimeout(r, 250));
    await browserPage.type("#newTeacherName", "Teste Gate");
    await browserPage.type("#newTeacherSubject", "Disciplina Teste");
    await browserPage.click('[onclick="addTeacher()"]');
    await new Promise(r => setTimeout(r, 400));
    const atBody = await rpcArg("teacher_add");
    const addMsg = await browserPage.evaluate(() => (document.getElementById("addMessage") || {}).textContent || "");
    log("admin add teacher payload", atBody && atBody.p_name === "Teste Gate" && atBody.p_subject === "Disciplina Teste", JSON.stringify(atBody));
    log("admin add teacher feedback", /adicionado/.test(addMsg), addMsg);

    // mobile: no document overflow with panel open
    await browserPage.setViewport({ width: 390, height: 844 });
    await new Promise(r => setTimeout(r, 300));
    const mov = await browserPage.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth
    }));
    log("admin mobile no overflow", mov.sw <= mov.iw, JSON.stringify(mov));
    await browserPage.setViewport({ width: 1440, height: 900 });
    await new Promise(r => setTimeout(r, 200));
    await browserPage.click('[onclick*="openTab(\'teachers\'"]');
    await new Promise(r => setTimeout(r, 300));
    await browserPage.screenshot({ path: path.join(OUT, "admin-panel-1440-" + THEME + ".png"), fullPage: false });

    // source: no native dialogs, has sticky table styles
    const src = fs.readFileSync(path.join(BASE, "admin.html"), "utf8");
    const noNatives = !/(?<![A-Za-z])(alert|confirm|prompt)\s*\(/.test(src);
    log("admin source no native dialogs", noNatives, "");
    log("admin source has sticky tables", src.includes(".twrap") && src.includes("position:sticky") && src.includes("thead"), "");

    log("admin no page errors", errs.length === 0, errs.join("; "));
  } finally {
    browserPage.off("request", onReq);
    await browserPage.setRequestInterception(false);
    await browserPage.evaluate(() => localStorage.removeItem("ecl-session"));
  }
}

// 8. CSS sanity: .hide exists, nav pill radius is 6px not 999, no blur on .top
{
  await open(browserPage, "index.html", 1440, 900);
  const css = await browserPage.evaluate(() => {
    const hide = getComputedStyle(document.querySelector(".hide") || document.createElement("div"));
    // find a nav link
    const a = document.querySelector(".top nav a");
    const top = document.querySelector(".top");
    const card = document.querySelector(".card") || document.querySelector(".tcard");
    return {
      hideDisplay: hide.display,
      navRadius: a ? getComputedStyle(a).borderRadius : null,
      topFilter: top ? getComputedStyle(top).backdropFilter : null,
      topBg: top ? getComputedStyle(top).backgroundColor : null,
      cardRadius: card ? getComputedStyle(card).borderRadius : null,
      cardShadow: card ? getComputedStyle(card).boxShadow : null,
      bodyFontVariant: getComputedStyle(document.body).fontVariantNumeric
    };
  });
  log("css hide", css.hideDisplay === "none", css.hideDisplay);
  log("css nav radius 6px", css.navRadius === "6px", css.navRadius);
  log("css no top blur", !css.topFilter || css.topFilter === "none", css.topFilter);
  log("css card radius 10px", css.cardRadius === "10px", css.cardRadius);
  log("css tabular nums", css.bodyFontVariant === "tabular-nums", css.bodyFontVariant);
}

// 8b. P3: a11y + theme toggle + contrast + motion + meta/favicon
{
  for(const f of pages){
    const src = fs.readFileSync(path.join(BASE, f), "utf8");
    const hasDesc = /<meta name="description" content="[^"]{20,}"/.test(src);
    const hasTC = (src.match(/name="theme-color"/g) || []).length === 2;
    const hasIcon = /rel="icon" href="favicon\.svg"/.test(src);
    const hasSkip = /class="skip" href="#main"/.test(src);
    const hasMain = /id="main"/.test(src);
    log("p3 source " + f, hasDesc && hasTC && hasIcon && hasSkip && hasMain,
      JSON.stringify({ hasDesc, hasTC, hasIcon, hasSkip, hasMain }));
  }
  log("p3 favicon file exists", fs.existsSync(path.join(BASE, "favicon.svg")), "");

  const cssSrc = fs.readFileSync(path.join(BASE, "style.css"), "utf8");
  log("p3 css on-ac tokens",
    /--on-ac:#fff/.test(cssSrc) && (cssSrc.match(/--on-ac:#111/g) || []).length >= 2, "");
  log("p3 css reduced motion", /prefers-reduced-motion:reduce/.test(cssSrc), "");
  log("m6 css skeletons",
    /\.sk\{/.test(cssSrc) && /sk-pulse/.test(cssSrc) &&
      /prefers-reduced-motion:reduce\)\{\s*\.sk\{/.test(cssSrc), "");

  // M7: CSP meta on every page + 404 page
  for(const f of pages){
    const s = fs.readFileSync(path.join(BASE, f), "utf8");
    log("m7 csp meta " + f, /<meta http-equiv="Content-Security-Policy" content="[^"]*script-src[^"]*"/.test(s), "");
  }
  const nf = path.join(here, "..", "404.html");
  const nfSrc = fs.existsSync(nf) ? fs.readFileSync(nf, "utf8") : "";
  log("m7 csp meta 404.html",
    /<meta http-equiv="Content-Security-Policy" content="[^"]*script-src[^"]*"/.test(nfSrc), "");
  log("m7 404 page",
    /404/.test(nfSrc) && /Página não encontrada/.test(nfSrc) &&
      /index\.html/.test(nfSrc), "");

  const admSrc = fs.readFileSync(path.join(BASE, "admin.html"), "utf8");
  log("p3 admin tab active dark fix",
    /\[data-theme="dark"\]\s*\.tab\.active/.test(admSrc) &&
    /:root:not\(\[data-theme="light"\]\)\s*\.tab\.active/.test(admSrc), "");

  const tSrc = fs.readFileSync(path.join(BASE, "teacher.html"), "utf8");
  log("p3 teacher radiogroup source",
    /radiogroup/.test(tSrc) && /aria-checked/.test(tSrc) && /selectStar/.test(tSrc), "");

  const fSrc = fs.readFileSync(path.join(BASE, "forum.html"), "utf8");
  log("p3 forum rail label source", fSrc.includes('aria-label="Comunidades"'), "");

  const idxSrc = fs.readFileSync(path.join(BASE, "index.html"), "utf8");
  log("p3 index live region source",
    idxSrc.includes('id="rcount"') && idxSrc.includes('aria-live="polite"'), "");

  const aSrc = fs.readFileSync(path.join(BASE, "auth.html"), "utf8");
  log("p3 auth live/alert source",
    aSrc.includes('id="auRules" class="chk" aria-live="polite"') &&
    aSrc.includes('id="auMsg" class="message" role="alert"'), "");

  // per-page DOM: toggle injected in the right slot, skip link first, main target
  for(const f of pages){
    let errs;
    if(f === "conta.html"){
      await open(browserPage, "index.html", 1440, 900);
      await browserPage.evaluate(() => localStorage.setItem("ecl-session", JSON.stringify({
        token: "gate-fake", exp: Math.floor(Date.now() / 1000) + 3600,
        username: "gate", role: "user", created_at: "2026-01-05T00:00:00Z"
      })));
      const CORS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Expose-Headers": "*"
      };
      const onR = req => {
        const u = req.url();
        if(u.includes("/rest/v1/") || u.includes("/rpc/")){
          req.respond({ status: 200, headers: CORS, contentType: "application/json", body: "[]" });
        } else {
          req.continue();
        }
      };
      await browserPage.setRequestInterception(true);
      browserPage.on("request", onR);
      try {
        errs = await open(browserPage, "conta.html", 1440, 900);
      } finally {
        browserPage.off("request", onR);
        await browserPage.setRequestInterception(false);
      }
      await browserPage.evaluate(() => localStorage.removeItem("ecl-session"));
    } else {
      errs = await open(browserPage, f, 1440, 900);
    }
    const r = await browserPage.evaluate(() => {
      const first = document.body.firstElementChild;
      return {
        skip: !!(first && first.tagName === "A" && first.classList.contains("skip") &&
                 first.getAttribute("href") === "#main"),
        main: !!document.getElementById("main"),
        navTgl: !!document.querySelector(".top #themeTgl")
      };
    });
    log("p3 dom " + f, r.skip && r.main && !r.navTgl, JSON.stringify(r));
    consoleErrors.push(...errs.map(e => f + ": " + e));
  }

  // index deep: skip focus, contrast, press, theme toggle
  const errsI = await open(browserPage, "index.html", 1440, 900);

  const skip = await browserPage.evaluate(async () => {
    const s = document.querySelector("a.skip");
    s.focus();
    await new Promise(r => setTimeout(r, 80));
    const out = { active: document.activeElement === s, left: getComputedStyle(s).left };
    s.blur();
    return out;
  });
  log("p3 skip link focuses", skip.active && parseFloat(skip.left) >= 0, JSON.stringify(skip));

  const CONTRAST_FN = () => {
    const parse = c => {
      if(!c) return null;
      if(c[0] === "#"){
        const h = c.length === 4
          ? c.slice(1).split("").map(x => x + x).join("")
          : c.slice(1);
        return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16));
      }
      const m = c.match(/[\d.]+/g);
      return m ? m.slice(0, 3).map(Number) : null;
    };
    const lum = rgb => {
      const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    };
    const ratio = (c1, c2) => {
      const a = lum(parse(c1)), b = lum(parse(c2));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    const out = {
      mutCard: ratio(v("--mut"), v("--card")),
      txBg: ratio(v("--tx"), v("--bg")),
      onAcAc: ratio(v("--on-ac"), v("--ac"))
    };
    const a = document.querySelector(".top a.on");
    if(a){
      const s = getComputedStyle(a);
      out.navOn = ratio(s.color, s.backgroundColor);
    }
    return out;
  };

  const c1 = await browserPage.evaluate(CONTRAST_FN);
  log("p3 contrast mut/card pre", c1.mutCard >= 4.5, c1.mutCard.toFixed(2));
  log("p3 contrast tx/bg pre", c1.txBg >= 7, c1.txBg.toFixed(2));
  log("p3 contrast on-ac/ac pre", c1.onAcAc >= 4.5, c1.onAcAc.toFixed(2));
  log("p3 contrast nav active pre", (c1.navOn || 0) >= 4.5, (c1.navOn || 0).toFixed(2));

  // inject test switches (theme now switches via [data-themeswitch], e.g. profile)
  await browserPage.evaluate(() => {
    if(!document.getElementById("tswProbe")){
      document.body.insertAdjacentHTML("beforeend",
        '<div id="tswProbe" style="position:fixed;top:0;left:0;z-index:99">' +
        '<button type="button" data-themeswitch="light">Claro</button>' +
        '<button type="button" data-themeswitch="dark">Escuro</button></div>');
    }
  });

  const pressIdle = await browserPage.evaluate(() => {
    const b = document.querySelector("#tswProbe button");
    return b ? getComputedStyle(b).filter : "missing";
  });
  const nbox = await (await browserPage.$("#tswProbe button")).boundingBox();
  await browserPage.mouse.move(nbox.x + nbox.width / 2, nbox.y + nbox.height / 2);
  await browserPage.mouse.down();
  await new Promise(r => setTimeout(r, 30));
  const pressDown = await browserPage.evaluate(() => {
    const b = document.querySelector("#tswProbe button");
    return b ? getComputedStyle(b).filter : "missing";
  });
  // release away from the button so no click fires before the toggle test
  await browserPage.mouse.move(1, 1);
  await browserPage.mouse.up();
  log("p3 press feedback", pressIdle === "none" && /0\.92/.test(pressDown), pressIdle + " -> " + pressDown);

  const tgl = await browserPage.evaluate(async () => {
    const doc = document.documentElement;
    const before = {
      attr: doc.getAttribute("data-theme"),
      bg: getComputedStyle(document.body).backgroundColor,
      sysDark: matchMedia("(prefers-color-scheme: dark)").matches
    };
    const effBefore = before.attr || (before.sysDark ? "dark" : "light");
    const expected = effBefore === "dark" ? "light" : "dark";
    const btn = document.querySelector('[data-themeswitch="' + expected + '"]');
    btn.click();
    // .top a transitions color/background over .15s — wait past it or the
    // contrast probe measures a mid-blend color
    await new Promise(r => setTimeout(r, 400));
    const light = document.querySelector('#tswProbe [data-themeswitch="light"]');
    const dark = document.querySelector('#tswProbe [data-themeswitch="dark"]');
    return {
      effBefore: effBefore,
      expected: expected,
      beforeBg: before.bg,
      attrAfter: doc.getAttribute("data-theme"),
      bgAfter: getComputedStyle(document.body).backgroundColor,
      stored: localStorage.getItem("ecl-theme"),
      lightPressed: light.getAttribute("aria-pressed"),
      darkPressed: dark.getAttribute("aria-pressed"),
      lightOn: light.classList.contains("on"),
      darkOn: dark.classList.contains("on")
    };
  });
  log("p3 toggle flips theme", tgl.attrAfter === tgl.expected, JSON.stringify(tgl));
  log("p3 toggle persists", tgl.stored === tgl.expected, String(tgl.stored));
  log("p3 toggle changes bg", tgl.beforeBg !== tgl.bgAfter, tgl.beforeBg + " -> " + tgl.bgAfter);
  log("p3 switch pressed sync",
    (tgl.expected === "dark"
      ? tgl.darkPressed === "true" && tgl.darkOn && tgl.lightPressed === "false" && !tgl.lightOn
      : tgl.lightPressed === "true" && tgl.lightOn && tgl.darkPressed === "false" && !tgl.darkOn),
    JSON.stringify({ expected: tgl.expected, lightPressed: tgl.lightPressed, darkPressed: tgl.darkPressed, lightOn: tgl.lightOn, darkOn: tgl.darkOn }));

  const c2 = await browserPage.evaluate(CONTRAST_FN);
  log("p3 contrast mut/card post", c2.mutCard >= 4.5, c2.mutCard.toFixed(2));
  log("p3 contrast tx/bg post", c2.txBg >= 7, c2.txBg.toFixed(2));
  log("p3 contrast on-ac/ac post", c2.onAcAc >= 4.5, c2.onAcAc.toFixed(2));
  log("p3 contrast nav active post", (c2.navOn || 0) >= 4.5, (c2.navOn || 0).toFixed(2));

  await browserPage.evaluate(() => {
    const p = document.getElementById("tswProbe");
    if(p) p.remove();
  });
  await shot(browserPage, "p3-theme-toggle-" + THEME);
  consoleErrors.push(...errsI.map(e => "index: " + e));

  // persistence across a navigation + row hover tint
  const errsT = await open(browserPage, "top.html", 1440, 900);
  const carry = await browserPage.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme")
  }));
  log("p3 theme persists across pages", carry.attr === tgl.expected, JSON.stringify(carry));

  const hoverOk = await (async () => {
    let row;
    try {
      row = await browserPage.waitForSelector("#list .rrow", { timeout: 8000 });
    } catch(e) {
      return null;
    }
    if(!row) return null;
    const before = await browserPage.evaluate(() =>
      getComputedStyle(document.querySelector("#list .rrow")).backgroundColor);
    await row.hover();
    await new Promise(r => setTimeout(r, 250));
    const after = await browserPage.evaluate(() =>
      getComputedStyle(document.querySelector("#list .rrow")).backgroundColor);
    return { before: before, after: after };
  })();
  log("p3 row hover tint", !!hoverOk && hoverOk.before !== hoverOk.after, JSON.stringify(hoverOk));
  consoleErrors.push(...errsT.map(e => "top: " + e));

  // reduced motion
  await browserPage.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const errsR = await open(browserPage, "index.html", 1440, 900);
  const rm = await browserPage.evaluate(() => {
    const a = document.querySelector(".top a");
    const card = document.querySelector(".tcard");
    return {
      link: a ? parseFloat(getComputedStyle(a).transitionDuration) : -1,
      card: card ? parseFloat(getComputedStyle(card).transitionDuration) : -1
    };
  });
  log("p3 reduced motion",
    rm.link >= 0 && rm.link <= 0.001 && rm.card >= 0 && rm.card <= 0.001, JSON.stringify(rm));
  await browserPage.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  consoleErrors.push(...errsR.map(e => "index: " + e));

  // teacher star widget: radiogroup semantics, click, arrow keys, value echo
  const errsS = await open(browserPage, "teacher.html?id=1", 1440, 900);
  const w0 = await browserPage.evaluate(() => {
    document.getElementById("rateForm").classList.remove("hide");
    document.getElementById("rateGate").classList.add("hide");
    const groups = document.querySelectorAll('#rateForm .stars[role="radiogroup"]');
    const radios = document.querySelectorAll('#rateForm .stars span[role="radio"]');
    return {
      groups: groups.length,
      radios: radios.length,
      g0: groups[0] ? groups[0].getAttribute("aria-label") : "",
      vals: Array.from(document.querySelectorAll("#rateForm [data-kv]")).map(e => e.textContent).join(",")
    };
  });
  log("p3 stars radiogroup",
    w0.groups === 3 && w0.radios === 15 && w0.g0 === "Clareza" && w0.vals === "0/5,0/5,0/5",
    JSON.stringify(w0));

  const w1 = await browserPage.evaluate(() => {
    const spans = document.querySelectorAll('#rateForm .stars[data-k="c"] span');
    spans[2].click();
    return {
      checked: Array.from(spans).map(s => s.getAttribute("aria-checked")).join(","),
      tidx: Array.from(spans).map(s => s.tabIndex).join(","),
      val: document.querySelector('#rateForm [data-kv="c"]').textContent
    };
  });
  log("p3 star click + value echo",
    w1.checked === "false,false,true,false,false" && w1.tidx === "-1,-1,0,-1,-1" && w1.val === "3/5",
    JSON.stringify(w1));

  const w2 = await browserPage.evaluate(() => {
    const spans = document.querySelectorAll('#rateForm .stars[data-k="c"] span');
    spans[2].focus();
    spans[2].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    return {
      active: Array.from(spans).indexOf(document.activeElement),
      checked: Array.from(spans).map(s => s.getAttribute("aria-checked")).join(","),
      val: document.querySelector('#rateForm [data-kv="c"]').textContent
    };
  });
  log("p3 star arrow key",
    w2.active === 3 && w2.checked === "false,false,false,true,false" && w2.val === "4/5",
    JSON.stringify(w2));
  log("p3 teacher stars no page errors", errsS.length === 0, errsS.join("; "));
  consoleErrors.push(...errsS.map(e => "teacher: " + e));

  // restore fixture defaults before block 9
  await browserPage.evaluate(() => { try{ localStorage.removeItem("ecl-theme"); }catch(e){} });
}

// 9. theme: light fixture should have data-theme and light tokens
if(THEME === "light"){
  await open(browserPage, "index.html", 1440, 900);
  const t = await browserPage.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme"),
    bg: getComputedStyle(document.body).backgroundColor
  }));
  log("light theme attr", t.attr === "light", JSON.stringify(t));
}

await browser.close();

// summary
const fails = results.filter(r => !r.ok);
const realConsoleErrors = consoleErrors.filter(e =>
  !/Failed to load resource|net::ERR|supabase/i.test(e)
);
console.log("\n=== SUMMARY " + THEME + " ===");
console.log("checks:", results.length, "fails:", fails.length);
if(fails.length) fails.forEach(f => console.log("  FAIL:", f.name, f.detail));
if(realConsoleErrors.length){
  console.log("console errors (non-CDN):");
  realConsoleErrors.slice(0,20).forEach(e => console.log("  ", e));
} else {
  console.log("console: clean (ignoring CDN/network)");
}
fs.writeFileSync(path.join(OUT, "results-" + THEME + ".json"), JSON.stringify({ results, consoleErrors }, null, 2));
process.exit(fails.length ? 1 : 0);
