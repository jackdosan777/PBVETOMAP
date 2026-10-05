# PB Real-time Map Veto System

Server-authoritative BO3 / BO5 map ban-pick for Point Blank esports tournaments.
Each team opens their own link on their own device; the server owns the rules, the
state and the 60-second clock.

---

## What it does

- **Toss #1** decides who acts first in the ban/pick (Team A is never assumed to start).
- **BO3**: ban, ban, pick→G1, pick→G2, ban, ban, referee random→G3.
- **BO5**: pick→G1, pick→G2, ban, ban, pick→G3, pick→G4, referee random→G5.
- Both formats consume 6 maps in steps 1–6, leaving **4 candidates** for the random draw.
- **60s per action.** At 00:00 the action locks, the team gets a **warning**, and the
  referee must press **CONFIRM WARNING & CONTINUE**. The system never picks, bans or
  forfeits on a team's behalf, and applies no other penalty.
- **Toss #2** decides the Game 1 side. The first-action team calls the coin; the toss
  winner picks RED or BLUE; the referee confirms and locks the result.
- **Game 2–5 side selection is deliberately not implemented** — it is handled outside
  this system.
- Full audit log, exportable as JSON by the referee.

## Roles and access

No accounts. Creating a match issues five links, each carrying its own token:

| Link | Can do |
|---|---|
| **Referee** | flip coins, confirm warnings, run and confirm the random draw, lock sides, export the log |
| **Team A** | call Toss #1 (when Team A), ban/pick on Team A's turns, choose side if they win Toss #2 |
| **Team B** | the same, for Team B |
| **Public** | read-only live view, safe to share |
| **OBS** | read-only minimal view for OBS Browser Source |

The role comes from the token on the server side. A client that forges a `role` field in
its socket payload is ignored — this is covered by the test suite.

> Send the two team links privately. Anyone holding a team link can act for that team.

---

## Running locally

```bash
npm install
cp .env.example .env        # then edit ADMIN_KEY
npm start
```

Open `http://localhost:3000`, enter your admin key, create a match, and distribute the links.

## Configuration

| Variable | Purpose |
|---|---|
| `ADMIN_KEY` | **Required in production.** Needed to create matches. Use a long random string. |
| `PORT` | Listen port. Most hosts set this automatically. |
| `PUBLIC_URL` | Base URL used when generating links, e.g. `https://veto.example.com`. If unset, links use the request's host, which is usually fine. |
| `DATA_DIR` | Where match JSON is written. Default `./data`. |
| `ENABLE_TEST_ENDPOINTS` | Leave unset. Only used by the automated tests. |

---

## Getting it onto GitHub

You do not need the git command line.

1. Create a **private** repository at <https://github.com/new>. Leave it empty — no
   README, no .gitignore.
2. On the empty repo page click **uploading an existing file**.
3. Unzip the project and drag the *contents* of the `pb-veto-server` folder into the
   browser (the files and the `src` / `public` folders, not the outer folder itself).
4. Commit.

If you do use git:

```bash
cd pb-veto-server
git init && git add . && git commit -m "PB Real-time Map Veto System"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Never commit a real `ADMIN_KEY`. `.gitignore` already excludes `.env`, `data/` and
`node_modules/`.

## Deploying

The app is plain Node + Socket.IO with no native dependencies, so it runs anywhere that
can run Node and keep a WebSocket open.

### Free: Render (recommended starting point)

Render's free plan runs this app as-is, including WebSockets.

1. Put this folder in a GitHub repository (see "Getting it onto GitHub" below).
2. Go to <https://dashboard.render.com> and sign in with GitHub.
3. **New +** → **Blueprint** → pick the repository. Render reads `render.yaml`
   and fills in the plan, build command, start command and health check for you.
4. Click **Apply**. The first build takes a few minutes.
5. Open **Environment** on the new service and copy the generated `ADMIN_KEY`.
6. Open `https://<your-service>.onrender.com`, paste the admin key, create a match,
   and send out the links.

If you would rather not use a Blueprint: **New +** → **Web Service** → pick the repo →
Runtime `Node`, Build `npm install`, Start `node server.js`, Plan `Free`, then add an
environment variable `ADMIN_KEY` yourself.

You do not need to set `PUBLIC_URL`: the server builds links from the incoming request,
and it is configured to trust Render's proxy, so the links come out as `https://`.

#### What "free" costs you

- **Cold start.** A free service spins down after 15 minutes with no traffic, and the
  next visitor waits roughly a minute while it wakes. Open the referee link two or three
  minutes before a match and it will be warm by the time the teams arrive.
  WebSocket messages count as activity, so an in-progress veto will not spin down
  mid-match ([Render changelog](https://render.com/changelog/free-web-services-now-remain-active-while-receiving-websocket-messages)).
- **No persistent disk.** Free services cannot mount a disk, so the match JSON files are
  lost whenever the service restarts or redeploys. The veto itself is unaffected while
  the match is running, but **export the veto log right after each match** if you need to
  keep it. Upgrading the plan and mounting a disk removes this limitation.

### Paid tiers

For a championship where a cold start or a lost log would be a problem, move to a paid
instance and mount a disk at `DATA_DIR`. Nothing in the code changes. Check the
provider's current pricing page; these tiers change often.

### Zepetto internal servers

A `Dockerfile` is included:

```bash
docker build -t pb-veto .
docker run -d -p 3000:3000 -e ADMIN_KEY=... -v /srv/pbveto:/app/data pb-veto
```

Put it behind your existing reverse proxy with HTTPS. The proxy must pass WebSocket
upgrade headers (`Upgrade` and `Connection`); nginx needs `proxy_http_version 1.1` and
the `Upgrade`/`Connection` headers set, otherwise the page loads but never goes live.

### A note on storage

Matches are written as JSON files in `DATA_DIR`. Some platforms use an ephemeral
filesystem, so those files disappear on redeploy. A match only lives for about an hour,
so this is usually survivable — but **if you need the audit log to persist, mount a
volume** (both Render and Railway offer them) or replace `src/store.js` with a database
implementation. That file exposes only four functions (`save`, `load`, `list`, `remove`),
so swapping it is a contained change.

---

## Project layout

```
server.js            Express + Socket.IO, token auth, match API
src/rules.js         Official rules: map pool, sequences, roles, errors (shared)
src/engine.js        Server-authoritative state machine and the 60s timer
src/store.js         JSON persistence (swappable)
public/admin.html    Create a match, get the five links
public/match.html    The match page for every role
public/app.js        Client views, driven entirely by server state
public/styles.css    Dark esports UI
test-live.js         Multi-browser integration test against a running server
```

## Architecture

```
captain / referee / public / OBS browsers
          |  socket.emit('action', intent)
          v
      server.js  --->  src/engine.js  (validates against src/rules.js)
          |                  |
          |                  +--> server-side 60s timer, fires TIMEOUT itself
          |
          +--->  io.to(room).emit('state', ...)  --->  every connected client re-renders
```

Clients hold no authoritative state and run no rule logic. They render what the server
sends and send back intents. The countdown on every screen is derived from the server's
deadline plus a measured clock offset, so all devices show the same number.

## Tests

With the server running on port 3100:

```bash
ADMIN_KEY=testkey PORT=3100 ENABLE_TEST_ENDPOINTS=1 node server.js &
node test-live.js
```

The test opens separate browser contexts for the referee and both captains and checks
role enforcement, forged-payload rejection, cross-device timer agreement, the timeout and
warning flow, reconnect recovery, the random draw, the side lock, and the gated log export.

## Known limits

- Matches are held in memory and mirrored to disk; the server is single-process. That is
  appropriate for this load (one match is a handful of connections). Running multiple
  instances behind a load balancer would need a shared store and a Socket.IO adapter.
- There is no rate limiting on the socket layer. Access is already restricted by
  unguessable tokens, but add a limiter if the service is exposed broadly.
- Game 2–5 side selection is intentionally absent; see above.
