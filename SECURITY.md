# Security — ECL Rating

Last audit: 2026-10-21 (static client + Supabase backend).

## Model

- Static multi-page site (HTML/CSS/JS). No build step, no server code.
- Backend is a Supabase project. The **anon key is public by design**:
  it only identifies the project. Every read/write goes through either
  row-level security (RLS) or `security definer` RPCs that authenticate
  with a custom session token.

## Authentication

- Passwords: bcrypt via pgcrypto (`crypt`, `gen_salt('bf')`), 8–72 chars.
- Usernames: `^[a-z0-9_]{3,20}$`, reserved names blocked
  (`admin`, `owner`, `moderator`, `root`, `system`).
- Sessions: 32 random bytes (hex) stored in `private.sessions`
  (RLS-locked, schema not exposed), 30-day expiry, revoked on logout.
- Login errors are generic; a dummy bcrypt comparison runs when the
  username does not exist to keep response timing uniform
  (anti-enumeration).
- Login brute-force throttle: `private.login_throttle` counts failures
  per username (sliding 15-minute window; 5 failures block further
  attempts with *Tenta mais tarde.*; counter cleared on success, stale
  rows purged after 1 day). Credential/throttle/ban failures are
  **returned as `{"error": ...}` instead of raising**, because an
  exception would roll back the counter insert in the same
  transaction; the client shows `data.error` and stores no session.

## Authorization

- Roles: `user` < `media` < `moderator` < `admin` < `owner`
  (+ `vip`, forum-branch creation only).
- All privileged RPCs call `private.require_min_role(token, min)`;
  `owner` is only assignable in SQL, admins can assign only
  `user`/`moderator`.
- Forum branches carry `access_view` / `access_publish` / `access_reply`
  levels: `forum_feed` hides branches below `access_view`,
  `forum_create` requires `access_publish`, `forum_reply` requires
  `access_reply` (resolved via the topic's root branch);
  levels are managed by moderators+ via `branch_access_update`, and
  creation (`branch_create`, moderator+) happens in the admin panel.
- Forum deletion follows a role hierarchy (mod: users only; admin: all
  except owner; owner: all). Pinned topics (`pinned`) are toggled only
  by `owner` via `post_pin`.
- Moderation: admins+ can mute (`user_mute`/`user_unmute`, timed or
  permanent) and ban (`user_ban`) only users ranked strictly below them.
  Bans revoke all sessions and block login; muted users cannot post,
  reply or rate.
- Profile flags: users set their own `country` (ISO 3166-1 alpha-2)
  via `user_set_country` (own profile only, token-authenticated,
  `^[A-Z]{2}$` enforced in SQL + check constraint); the value is
  exposed through the `profiles` view and rendered from flagcdn.com.
- Post editing: `post_edit` allows authors to edit **their own**
  forum posts only (`user_id is distinct from v` rejects everyone
  else, including admins; anonymous posts are untouchable), with
  1–2000 chars and no time limit; sessions must be valid,
  unmuted and unbanned.
- Audit log: `private.mod_log` records every moderation action
  (`rating_delete`, `branch_create`, `branch_access_update`,
  `post_pin`, `post_edit`, `forum_delete`, `user_set_role`,
  `user_mute`, `user_unmute`, `user_ban`) with actor id, target and
  a `jsonb` detail via `private.log_mod` (security definer, no
  grants). Readable only by moderators+ through `mod_log_list`
  (`require_min_role('mod')`, last 100 entries, actor username
  resolved server-side); the table itself is RLS-locked with no
  policies and the `private` schema has no USAGE for API roles.
- Tables `forum_posts`, `forum_branches`, `forum_votes`, `teachers`,
  `ratings`: RLS on; REST writes revoked; forum reads only via
  `forum_feed` (no public-read policy).

## Client XSS posture

- All dynamic HTML goes through `esc()` (escapes `& < > " '`) or
  `escAttr()`; numeric fields are coerced with `Number()`.
- `textContent` used for plain values; no `eval`, `Function`,
  `insertAdjacentHTML`, or `document.write`.
- `auth.html?next=` is whitelisted to same-origin page names
  (`index|forum|teacher|admin|top|conta.html` + query/hash), which
  closes open-redirect abuse.

## Accepted limitations

- Session tokens live in `localStorage` (inherent to a static SPA-style
  site); an XSS flaw could expose them — mitigated by the XSS posture
  above and server-side logout revocation.
- Tokens are stored plaintext in the DB (DB access = session theft).
- No rate limiting on register/RPCs beyond what Supabase applies
  (login itself has the per-username brute-force throttle above).
- Users may vote on their own forum posts.
- No CSP headers (depends on the static host); meta-CSP is a possible
  future hardening.

## Verification

- Functional/visual gate suite (puppeteer, dark + light fixtures) runs
  on every change: console-clean, overflow, a11y, theme, and role-gated
  UI checks.
- `setup.sql` is validated end-to-end against a local PostgreSQL:
  the full idempotent file runs clean, then RPC smoke tests exercise
  register/login, throttle counting, forum CRUD, moderation and the
  audit log.
- `setup.sql` is gitignored; schema changes are applied manually in the
  Supabase SQL Editor (migration block at the bottom of that file).

## Reporting

Open an issue at https://github.com/6096-fpv/ECL_rating/issues.
