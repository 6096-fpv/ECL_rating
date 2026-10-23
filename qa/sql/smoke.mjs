import EmbeddedPostgres from "embedded-postgres";
import fs from "fs";
import { fileURLToPath } from "url";
import pgpkg from "pg";

const { Client } = pgpkg;
const SETUP = fileURLToPath(new URL("../../setup.sql", import.meta.url));
const PORT = 55499;

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
  if (!ok) fails++;
}

const ep = new EmbeddedPostgres({
  databaseDir: "./data",
  user: "postgres",
  password: "pw",
  port: PORT,
  persistent: false,
});

await ep.initialise();
await ep.start();

async function connect(db) {
  const c = new Client({ host: "127.0.0.1", port: PORT, user: "postgres", password: "pw", database: db });
  await c.connect();
  return c;
}

const boot = await connect("postgres");
await boot.query("drop database if exists ecl_test");
await boot.query("create database ecl_test encoding 'UTF8' template template0");
await boot.end();

const db = await connect("ecl_test");
db.on("error", () => {});

await db.query("create schema extensions; create extension if not exists pgcrypto;");
await db.query(`do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;`);

const sql = fs.readFileSync(SETUP, "utf8");
try {
  await db.query(sql);
  check("setup.sql runs", true);
} catch (e) {
  check("setup.sql runs", false, e.message);
  await db.end().catch(() => {});
  await ep.stop().catch(() => {});
  process.exit(1);
}

async function rpc(name, ...args) {
  const ph = args.map((_, i) => "$" + (i + 1)).join(",");
  const r = await db.query(`select public.${name}(${ph}) as out`, args);
  return r.rows[0].out;
}

async function expectErr(name, fn, re) {
  try {
    await fn();
    check(name, false, "no error raised");
  } catch (e) {
    check(name, re.test(e.message), e.message);
  }
}

// three users: alice (future owner), bobby (future mod), plain1 (always plain)
await rpc("register", "alice", "senha1234");
await rpc("register", "bobby", "senha1234");
await rpc("register", "plain1", "senha1234");
const la = await rpc("login", "alice", "senha1234");
const lb = await rpc("login", "bobby", "senha1234");
const lp = await rpc("login", "plain1", "senha1234");
check("login returns tokens", !!(la.token && lb.token && lp.token));

// forum + post_edit (own only)
const t1 = await rpc("forum_create", la.token, "Topico um", "conteudo inicial");
check("forum_create", !!t1.id, JSON.stringify(t1));
const ed = await rpc("post_edit", la.token, t1.id, "conteudo editado");
check("post_edit own", ed.content === "conteudo editado", JSON.stringify(ed));
await expectErr("post_edit foreign", () => rpc("post_edit", lb.token, t1.id, "hack"), /próprias mensagens/);
await expectErr("post_edit empty", () => rpc("post_edit", la.token, t1.id, "   "), /máximo 2000/);

// login throttle: 5 fails block the 6th (even with the right password).
// failures must SURVIVE (login returns {error} instead of raising, else
// the raise would roll back the counter insert)
let failErrs = 0;
for (let i = 0; i < 5; i++) {
  const r = await rpc("login", "alice", "errada123");
  if (r && r.error === "Credenciais incorretas.") failErrs++;
}
check("wrong password returns error json", failErrs === 5, "got " + failErrs + "/5");
const th = await db.query("select fails from private.login_throttle where username = 'alice'");
check("failures counted (fails=5)", th.rows.length === 1 && th.rows[0].fails === 5, JSON.stringify(th.rows));
const r6 = await rpc("login", "alice", "senha1234");
check("login throttle blocks", r6 && r6.error === "Tenta mais tarde.", JSON.stringify(r6));
await db.query("delete from private.login_throttle");
const laOk = await rpc("login", "alice", "senha1234");
check("login works after reset", !!laOk.token);

// alice -> owner (SQL), then promote bob to moderator via RPC (audited)
await db.query("update private.site_users set role = 'owner' where username = 'alice'");
const bobId = (await db.query("select id from private.site_users where username='bobby'")).rows[0].id;
const sr = await rpc("user_set_role", laOk.token, bobId, "moderator");
check("user_set_role", sr.role === "moderator", JSON.stringify(sr));

// rating_delete by moderator (audited)
const tid = (await db.query("insert into public.teachers (name, subject) values ('T','M') returning id")).rows[0].id;
const rid = (await db.query("insert into public.ratings (teacher_id, clareza, apoio, justica) values ($1,5,5,5) returning id", [tid])).rows[0].id;
await rpc("rating_delete", lb.token, rid);

// branch_create by moderator (audited)
const bch = await rpc("branch_create", lb.token, "Sala da staff");
check("branch_create", !!bch.id, JSON.stringify(bch));

// pin by owner (audited)
const pin = await rpc("post_pin", laOk.token, t1.id, true);
check("post_pin", pin.pinned === true, JSON.stringify(pin));

// forum_delete: a moderator may delete a plain user's topic (audited with title)
const t2 = await rpc("forum_create", lp.token, "Topico dois", "dois");
const fd = await rpc("forum_delete", lb.token, t2.id);
check("forum_delete", fd.ok === true, JSON.stringify(fd));

// mod_log_list: moderator sees the entries
const log = await rpc("mod_log_list", lb.token);
const actions = (log.rows || []).map(r => r.action);
for (const a of ["user_set_role", "rating_delete", "branch_create", "post_pin", "post_edit", "forum_delete"]) {
  check("mod_log has " + a, actions.includes(a), actions.join(","));
}
check("mod_log rows shape",
  (log.rows || []).length >= 6 && (log.rows || []).every(r => r.actor && r.ts && r.id),
  JSON.stringify(log.rows && log.rows.length));
const fdRow = (log.rows || []).find(r => r.action === "forum_delete");
check("mod_log forum_delete detail",
  fdRow && fdRow.detail && fdRow.detail.title === "Topico dois" && fdRow.detail.author === "plain1",
  JSON.stringify(fdRow));

// plain user cannot read the log
await expectErr("mod_log_list requires mod",
  () => rpc("mod_log_list", lp.token), /permissões/);

// news_count: since filter + branch visibility (admin branch hidden from anon)
const nAll = await rpc("news_count", null, null);
const nFuture = await rpc("news_count", null, "2100-01-01T00:00:00Z");
check("news_count since filter",
  nAll.count >= 1 && nFuture.count === 0,
  JSON.stringify({ nAll: nAll.count, nFuture: nFuture.count }));

const bAdmin = await rpc("branch_create", laOk.token, "Staff only", "admin", "admin", "admin");
const tStaff = await rpc("forum_create", laOk.token, "Topico staff", "segredo", null, bAdmin.id);
check("admin-branch topic created", !!tStaff.id, JSON.stringify(tStaff));
const nAnon = await rpc("news_count", null, null);
const nOwner = await rpc("news_count", laOk.token, null);
check("news_count hides admin branch from anon",
  nOwner.count === nAnon.count + 1,
  JSON.stringify({ anon: nAnon.count, owner: nOwner.count }));

await db.end();
await ep.stop();

console.log(fails === 0 ? "ALL OK" : fails + " FAILURES");
process.exit(fails ? 1 : 0);
