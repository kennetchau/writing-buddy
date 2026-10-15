# RESOLVED 2026-10-07: force-logout + AI badge stuck "running"

Status: **ROOT CAUSE FOUND AND FIXED 2026-10-07 — a units bug in the session
cookie. It was NEVER a browser, cert, or nginx problem.** The session cookie
was being set with a 43-second lifetime instead of 12h, so the browser
discarded it ~43s after login and the next request 401'd. See
`## ACTUAL ROOT CAUSE` below. Fix + regression test in place; re-deploy to
the host (`deploy/install-quadlet.sh`) and it's done.

## ACTUAL ROOT CAUSE — session cookie `Max-Age` was 43 seconds, not 12h

Express `res.cookie` takes `maxAge` in **milliseconds**. `src/auth/session.ts`
passed the 12h value **in seconds** (`SESSION_HOURS * 3600` = `43200`), which
Express read as 43200 **ms = 43 s**. Proven from the live server's own
Set-Cookie (captured with curl 2026-10-07, byte-exact):

```
Date:        Wed, 07 Oct 2026 16:14:38 GMT
Set-Cookie:  session=…; Max-Age=43; Path=/; Expires=Wed, 07 Oct 2026 16:15:21
             GMT; HttpOnly; Secure; SameSite=Lax
```

`Date` → `Expires` is exactly 43 s. (Express also sets `Expires` from the same
ms value — `node_modules/express/lib/response.js` `opts.expires = new Date(
Date.now() + maxAge)` — so both were 43 s.)

Why the **browser** discards a cookie this fast: `Max-Age` beats `Expires`,
and per RFC 6265 §5.3 the client MUST delete a cookie whose expiry has passed;
Firefox prunes expired cookies continuously. So ~43s after login (or after the
cookie's last slide) the cookie is gone.

This explains **every** observed fact, including the ones that defeated the
browser/cert theories:
- 401s with **no Cookie header** — the browser correctly stopped sending a
  cookie it had already expired.
- **No Set-Cookie ever** — the server never re-issued one; it was innocent.
- "after a while, even while actively using it" — ~43 s window.
- **Private windows too** — unrelated to profile; it's the cookie's own TTL.
- **Jupyterhub / cockpit fine** — they set a real Max-Age. This was always
  *our* cookie, not a host/browser condition.

**Fix:** `src/auth/session.ts` now uses one shared constant
`SESSION_TTL_MS = 12 * 3600_000` for BOTH the cookie `maxAge` (ms, as Express
wants) and the DB `expires_at`, so they can't drift, with a comment explaining
the ms-vs-seconds trap. **Regression test** added in `tests/phase1.spec.ts`:
asserts the emitted `Max-Age` is `43200` (would have failed on the old `43`).
Verified on a local boot: now emits `Max-Age=43200 … Expires=+12h`.

### What to do on the host
1. `deploy/install-quadlet.sh` (rebuild + restart → new image with the fix).
2. Log in and it now sticks for 12h (12h sliding). Nothing else to change.
3. Optional: the earlier `?next=` + banner + `reason` + `[req]` logging
   changes are still worth keeping (they made this diagnosable), but they are
   NOT what fixes the logout.

### The two WRONG conclusions from earlier this session (do not re-litigate)
1. **"The vhost serves the wrong cockpit.*.sslip.io cert" (root cause).**
   WRONG. A hostname-mismatched cert the user accepted does not make Firefox
   withhold cookies. The user re-signed the cert + added a Firefox exception
   and it *still* dropped — confirming this. (Renewed cert now shows
   `CN=localhost`; that's fine as long as the exception is kept.)
2. **"Firefox security-state flip / browser stops sending a valid cookie."**
   WRONG. The cookie was valid for 43s then genuinely expired — the browser
   was behaving correctly the whole time.

## SECOND BUG: AI progress indicator stuck "running" with no job

- Symptom: AI Monitor (and/or navbar badge) shows an active action even when
  nothing is running. Confirmed in code: `GET /api/ai/current` and the AI
  Monitor read the **in-memory** `activeByUser` map (never the DB), so the
  "stuck running" is a **frontend** state bug — `ai_monitor.hbs`
  `refreshActive()` did `res.json()` on a 401, which threw into `catch {}`
  and left the status stuck until reload. The new client (see "What changed")
  handles the 401 so the status clears. Re-test after re-deploy.

## What changed in the app (this session, all tested)

- **ROOT-CAUSE FIX — session cookie `Max-Age`**: `src/auth/session.ts` now
  uses one shared `SESSION_TTL_MS` (ms) for both the cookie `maxAge` (Express
  wants ms) and the DB `expires_at`. Previously the 12h value was passed in
  *seconds* → Express emitted `Max-Age=43` → the browser expired the cookie
  after ~43s → the force-logout. Regression test asserts `Max-Age=43200`.
- **`?next=` round-trip** (kept): unauth page GETs → `/login?next=<page>`;
  the login form carries `next` (same-origin-validated) and the POST redirects
  back there.
- **Client `?next=` banner + 401 handling** (kept): `src/public/js/app.ts`
  turns the first 401 into a visible banner and returns the user to the same
  page; badge/monitor 401s are handled (no more stuck "running").
- **401 `reason` + server log** (kept, now diagnostic-only): `getSessionUser()`
  returns `{user, reason: valid|expired|unknown|missing}`; the template-local
  lookup uses `{deleteExpired: false}` so it can't consume an expired row
  before the auth layer reports it.
- **`REQ_LOG=1`** (kept): `[req]` line per request with cookie state — the
  decisive capture if any auth oddity ever recurs.
- **`COOKIE_SECURE`** (kept): prod sets `Secure` on the cookie (HTTPS-only).
- **Flat SSE `done` payload** reads fixed in `views/story_detail.hbs` +
  `views/lore_entry.hbs`.
- **Chapter delete button** (new ask): the delete endpoint
  (`POST /api/stories/:id/chapters/:n/delete`, renumbers the rest, guards
  finalized) existed but had no UI — added a "Delete chapter" button in the
  chapter pane with a confirm.

## Host-side steps (after push)

1. `deploy/install-quadlet.sh` (rebuild + restart → new image with the
   **Max-Age fix** + `COOKIE_SECURE=true` + `REQ_LOG=1`).
2. Log in → it now sticks 12h. That's the fix. Verify the cookie if in doubt:
   `curl -sk -D - -o /dev/null -X POST -H 'content-type: application/json' \
     -d '{"username":"admin","password":"<pw>"}' https://story.<lan-domain>/api/login \
     | grep -i set-cookie` → must show `Max-Age=43200`, **not** `Max-Age=43`.
3. The `?next=` / banner / `reason` / `[req]` logging changes stay in (they
   made this diagnosable) but are not what fixes the logout.
4. Rotate the admin password pasted into logs last session (see cleanup owed).

## Symptom (user reports, verbatim facts)

- Single browser (Firefox 157, Linux), one tab, one session, same URL
  (`https://story.<lan-domain>`), same client IP (`192.168.x.x`) for all
  requests.
- User stays logged in and can use everything (generate chapters, edit
  lore, etc.). **After a while — sometimes even while actively using it —
  the app is logged out.** Visually the user stays in the app; the next
  nav click (full page load) lands on /login.
- Network tab at that moment: `GET /api/model` and `GET /api/ai/current`
  (the 5 s polls) return **401 with NO Cookie header on the request**.
  Server response has **no Set-Cookie** (no deletion response ever seen).
- The cookie IS still in the browser's cookie jar (DevTools → Storage →
  Cookies shows `session` with a real ~12 h Expires/Max-Age). So:
  **browser has the cookie but stops sending it on some requests.**
- **A private (non-persistent) window does the same thing** → profile
  extensions/settings largely ruled out.
- Same browser/profile/network hosts cockpit + jupyterhub on
  `*.<lan-domain>` with NO such problem.
- AI Monitor: **the "active action" / AI-progress indicator always shows
  running even when no job is running** (second bug, see below).

## Deploy topology (facts)

- `story.<lan-domain>` → **nginx** (1 vhost, standard reverse proxy,
  `proxy_pass http://host.containers.internal:9187`, SSE-friendly:
  `proxy_buffering off`, 3600 s timeouts, `client_max_body_size 20m`).
  No cookie/auth directives. Nginx config reviewed twice — clean.
- nginx → **novel-app container** (quadlet, rootless podman, custom
  bridge network `novel` 10.91.0.0/24) → **novel-db** (postgres).
- **AdGuard is the LAN DNS.** Nginx resolves `story.<lan-domain>` itself;
  the app container resolves `novel-db` via CNI DNS.
- Llama.cpp reachable from app (verified: `host.containers.internal:21000`
  AND `10.2.0.2:21000` both work from inside the container).

## What has been PROVEN (don't re-litigate)

1. **App code cannot drop a session except the two logout routes.**
   `DELETE FROM session` exists only in `destroySession()`, called only
   from `POST /logout` + `POST /api/logout` (grep-verified). Sessions are
   **random tokens in Postgres, NOT signed** — `SESSION_SECRET` is loaded
   but never used to sign anything. Restarting the app / regenerating the
   secret cannot kill a cookie. (→ user's "secret issue" hypothesis: no.)
2. **Cookie is set correctly**: `httpOnly, SameSite=Lax, path=/,
   Max-Age=43200` — a persistent cookie (confirmed in browser: real expiry).
3. **Server-side cookie round-trip works**: curl login → 3× /api/me all
   authed. Session rows accumulate and persist across app restarts
   (32 rows at last check).
4. **The 401s arrive with no Cookie header** (debug log added to
   `requireAuth` in `src/auth/middleware.ts`, grep `"NO cookie at all"`):
   `401 GET /api/model — NO cookie at all (host=story.<lan-domain>,
   xff=192.168.x.x)` in steady 5 s intervals = the page's own polls.
   All from the same host+IP. Server never saw the cookie die.
5. Browser-side: **cookie present in jar, not sent** → Firefox is
   suppressing it per-request. Not the server, not nginx (it forwards
   request headers verbatim, no cookie directives).
6. **Private window reproduces it** → not a profile extension (probably).
   → The "browser refuses to send a valid persistent SameSite=Lax cookie
   for a site" behavior is what we must explain.

## Suspects (SUPERSEDED — historical only)

> **RESOLVED: the root cause was the cookie `Max-Age` units bug (see top of
> this file). None of the suspects below were the cause.** Suspect A (the
> cert) was **never** a contributor — it was a red herring, and the "Firefox
> stops sending a valid cookie" framing was simply wrong: the cookie was
> expiring in 43 s, so Firefox *correctly* stopped sending it. Keep this
> section only as a record of how the bug was hunted. `deploy/diag-autologout.sh`
> and the `?next=`/`reason`/`REQ_LOG` additions remain useful diagnostics.


### A. Something in the RESPONSES makes Firefox distrust the site
Firefox will stop attaching cookies to a site after a security state
change (cert error, HSTS preload quirk, mixed content). **Check:**
   - the actual cert served for `story.<lan-domain>` today:
     `echo | openssl s_client -connect story.<lan-domain>:443
        -servername story.<lan-domain> 2>/dev/null | openssl x509 -noout
        -subject -ext subjectAltName`
     (An earlier capture showed CN=cockpit.<server-ip>.sslip.io for a
     request to story.<lan-domain> — user said sslip was "before DNS was
     set up" but NEVER re-verified. If the vhost still serves the wrong
     cert / missing SAN, that is the #1 suspect: Firefox treats the site
     as insecure and does not attach its cookies — fits ALL facts
     including private windows.)
   - In Firefox at the "logged out" moment: the address-bar padlock,
     page info → connection security. Is it "Not Secure / Private
     connection not secure"?
   - Any **mixed content** (http:// subresources) in the page?

### B. The app/nginx response headers on the HTML pages
   - No `Secure` flag is set on the cookie (`sessionCookieOptions()` in
     `src/auth/session.ts` has no `secure: true`). Site is HTTPS-only
     (nginx listens 443 only). A cookie without `Secure` on an https site
     is legal, but: verify Firefox isn't dropping it due to some
     interaction. **Fix worth doing regardless: add `secure: true`**
     (and re-test). Also verify there's no accidental `Secure`/non-secure
     flip because the app also gets reached via plain http somewhere
     (nginx only has :443 — confirm no :80 vhost exists on the host).
   - Dump the full headers the app returns for the login POST and a page
     GET: look for anything odd (multiple Set-Cookie, weird Path/Domain).

### C. Nginx worker / proxy behavior under the SSE polls
   - Two long-lived-ish connections (SSE keepalive 15 s comments) +
     polls every 5 s. Check `nginx -T | grep -A5 'story\.'` for
     `keepalive`/`proxy_next_upstream` and the **access log** around the
     logout moment: do the 401s start right after a 499/502/504?
   - `tail -f /var/log/nginx/access.log` while the app is open; catch the
     moment it flips to 401. If the first 401 follows a 502/504/499,
     nginx/proxy is mid-frame and we dig there.

### D. Full code review (user's explicit ask — DO THIS FIRST)
   Read the whole `src/` + `views/` for ANY of:
   - extra `res.cookie` / `set-cookie` writers (currently only 3: two
     login paths + change-password — all set a FRESH token; note that
     every successful login/chg-pw ROTATES the token while old rows stay
     in the DB — harmless but keep in mind),
   - any place that calls `requireAuth` differently for pages vs XHR,
   - anything that responds 200 with a redirect or a 401 with a body that
     could make the browser treat the site oddly,
   - the template local middleware in `src/app.ts` (runs getSessionUser on
     EVERY render — DB hit per render; check it can't throw in a way that
     500s the HTML but not the XHRs — a 500 on the page load would not
     redirect to /login, so probably not it, but check),
   - Express trust-proxy: the app is behind nginx; check whether
     `app.set("trust proxy", ...)` is set. Without it, `req.headers` are
     fine, but any code using `req.ip`/`req.protocol` sees the nginx
     proxy, not the client — search for uses.

## SECOND BUG: AI progress indicator stuck "running" with no job

- Symptom: AI Monitor (and/or navbar badge) shows an active action
  even when nothing is running.
- Code facts (from `src/ai/runs.ts` + `src/ai/routes.ts`):
  - `activeByUser` is **in-memory** (per-process Map). Runs persist to
    the `ai_run` table, but "active" state does NOT survive a restart.
  - `startRun` inserts an `ai_run` row with NO status column set to
    'running' in SQL (relies on a default — **check schema default for
    `ai_run.status`**; if the default is 'running' and a run is created
    then the process dies before finish/fail, the row is stuck forever
    — but `getActiveRunForUser` reads the in-memory map, so that alone
    can't stick the badge... unless the badge/monitor page reads the DB.
    **CHECK: what does `GET /api/ai/current` and the AI Monitor page
    render from — memory or DB?** `routes.ts:75` + `routes.ts:236` use
    `getActiveRunForUser` (memory). So the "always running" is more
    likely a FRONTEND state bug (JS never clears the active card after
    done/error — inspect `views/ai_monitor.hbs` refreshActive() and the
    navbar badge poll for missing terminal-state handling) OR a run that
    is genuinely stuck: `emit()` for `start` happens, then the action
    promise neither resolves nor rejects (e.g. fetch with no timeout on
    the stream, or an unhandled throw OUTSIDE the `.catch(failRun)` in
    `routes.ts` beginAction — check that `runGenerate` et al. cannot
    throw synchronously before the catch attaches).
  - Also check: does a 401 mid-stream (i.e. THIS LOGOUT BUG) kill the
    SSE without finishing the run, leaving `activeByUser` populated
    forever? `req.on("close")` in the stream handler only unsubscribes —
    it does NOT fail the run. A run whose only client disconnected is
    left "running" in memory until the model call returns. Combined with
    logout → 401 on polls → badge stuck. **These two bugs may be the
    same root event.**
- Next session: instrument + read `views/ai_monitor.hbs` fully and
  `src/ai/actions.ts` (timeouts on the streaming fetch — `LLM_READ_TIMEOUT`
  is 900 s of SILENCE allowed; a dead connection may hold the run for 15 min).

## Cleanup owed

- **Diagnostics are env-gated, not to be "removed later":** the per-request
  `[req]` line (with cookie state) is behind `REQ_LOG=1` (`src/app.ts`; the
  prod unit sets it), and the 401 reason line (`[auth] 401 …`) in
  `src/auth/middleware.ts` is a plain `console.warn`. If the journal gets
  noisy after the re-deploy, drop `Environment=REQ_LOG=1` from
  `deploy/quadlet/novel-app.container` + the warn — they were the tools that
  found this bug, so keep them until a deploy has been confirmed stable.
- `deploy/diag-*.sh`, `deploy/verify-deploy.sh`, **`deploy/diag-autologout.sh`**
  are useful; keep.
- User password: a temp password was pasted into logs during the last
  session (redacted) — user should have rotated it; verify.
- `install-quadlet.sh` now uses `restart` (was `start` — silent no-op on
  re-runs, cause of the "rebuild didn't apply" detour).
- `ADMIN_PASSWORD` in the unit was supposed to be set to
  `x-disabled-x` — verify it happened (finish-deploy.sh does it).
- **Done this session:** 401 `reason` (missing/unknown/expired) on
  `/api/me` + `requireAuth` + server log; template-local lookup uses
  `{deleteExpired: false}`; `?next=` round-trip (middleware → login form →
  POST redirect, same-origin-validated); client banner + fetch wrapper
  (`src/public/js/app.ts`); badge/monitor 401 handling (no more stuck
  "running"); `COOKIE_SECURE=true` in the app unit (Secure cookie flag on
  the HTTPS-only site; env-gated so local HTTP dev keeps working); flat SSE
  `done` payload reads fixed in `views/story_detail.hbs` +
  `views/lore_entry.hbs`.

## Hard-won lesson for the next session

This session burned the user's patience by: (1) guessing at browser
theories instead of doing the full code review first, (2) making deploy
changes piecemeal that each needed host-side re-runs, (3) never verifying
the served certificate for story.<lan-domain> despite seeing the sslip CN
in the capture. **Order of work: full code review → one diagnostic that
captures the flip moment (nginx access log + app journal together) →
then fix.**
