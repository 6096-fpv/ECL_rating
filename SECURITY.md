# Security — ECL Rating

Last audit: 2026-10-16 (static client + Supabase backend).

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
  levels are managed by moderators+ via `branch_access_update`.
- Forum deletion follows a role hierarchy (mod: users only; admin: all
  except owner; owner: all). Pinned topics (`pinned`) are toggled only
  by `owner` via `post_pin`.
- Moderation: admins+ can mute (`user_mute`/`user_unmute`, timed or
  permanent) and ban (`user_ban`) only users ranked strictly below them.
  Bans revoke all sessions and block login; muted users cannot post,
  reply or rate.
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
- No rate limiting on login/register/RPCs beyond what Supabase applies.
- Users may vote on their own forum posts.
- No CSP headers (depends on the static host); meta-CSP is a possible
  future hardening.

## Verification

- Functional/visual gate suite (puppeteer, dark + light fixtures) runs
  on every change: console-clean, overflow, a11y, theme, and role-gated
  UI checks.
- `setup.sql` is gitignored; schema changes are applied manually in the
  Supabase SQL Editor (migration block at the bottom of that file).

## Reporting

Open an issue at https://github.com/6096-fpv/ECL_rating/issues.
