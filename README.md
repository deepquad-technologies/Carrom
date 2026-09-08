# Carrom Club

A cross-platform multiplayer carrom game — web, Android and iOS — with a real
physics engine, an authoritative server, cosmetics, crates and moderation
tooling.

> **Virtual currency only.** Coins in this project are an in-game score. There
> is no purchase, deposit, withdrawal, transfer, cash prize, or wagering of real
> money anywhere in the codebase, and no code path that could become one without
> a deliberate new feature. This is a skill-based entertainment game.

---

## What is here

Everything below is **verified against a live database**: `npm run test:e2e` signs
two players in, matchmakes them, plays a real board over sockets and checks the
money moved correctly. 69 unit tests plus 46 end-to-end checks, all passing.

| Area | Status |
| --- | --- |
| Deterministic carrom physics + full rule set | Working, 69 tests passing |
| Authoritative real-time server (Socket.IO) | Working |
| Auth: email, Facebook, Google, guest, JWT + refresh rotation | Working |
| Postgres schema, migrations, seed | Working |
| 50 strikers, 50 coin sets, 20 boards, 5 rarities | Working |
| Crates, rewards, XP, levels, achievements, missions | Working |
| Matchmaking, private rooms, reconnection, AFK, turn clock | Working |
| Friends, leaderboards, tournaments | Working |
| Reports → admin review → ban | Working |
| Anti-cheat signals + review queue | Working |
| Spectator mode, presence, follows | Working |
| Seasons, ranked divisions, fair play score | Working |
| Daily login rewards with streaks | Working |
| Admin-editable runtime config, idempotent rewards | Working |
| Web app (Next.js) | Builds, 8 routes |
| Mobile app (Expo / React Native) | Typechecks, screens implemented |
| Admin dashboard (Next.js) | Builds, 7 routes |

---

## Layout

```
carrom/
├── apps/
│   ├── api/            Express + Socket.IO + Postgres + Redis
│   ├── web/            Next.js 14, Tailwind, canvas board
│   ├── mobile/         Expo / React Native, SVG board
│   └── admin/          Next.js moderation dashboard
├── packages/
│   ├── types/          Shared TypeScript types and the wire protocol
│   ├── config/         Board geometry, tiers, timers, modes, security limits
│   ├── physics/        Deterministic simulation + opening layout
│   ├── game-engine/    Carrom rules, seating, shot validation
│   ├── content/        Strikers, coin sets, boards, crates, achievements
│   └── ui/             One renderer, two backends (canvas + SVG)
└── infrastructure/
    ├── docker/         docker-compose, API image
    ├── database/       SQL migrations
    └── deployment/
```

The shared packages ship TypeScript source. Next transpiles them, Metro resolves
them through `metro.config.js`, and the API runs them with `tsx` — so there is no
build step between editing a package and using it.

---

## Running it

**Requires** Node 20+ and Docker (for Postgres and Redis).

```bash
npm install
```

```bash
npm run docker:up
```

```bash
cp apps/api/.env.example apps/api/.env
```

```bash
npm run dev
```

That starts the API on `:4000` and the web app on `:3000`. Migrations and the
content seed run automatically on API boot, so a fresh database needs no extra
step. Sign in with **Play now as guest** — no configuration required.

Other apps:

```bash
npm run dev:admin
```

```bash
npm run dev:mobile
```

Mobile: set `extra.apiUrl` in `apps/mobile/app.json` to your machine's LAN
address (not `localhost`) before running on a physical device.

---

## Environment variables

Everything lives in `apps/api/.env` (copy from `.env.example`). The values that
matter:

| Variable | What it does |
| --- | --- |
| `DATABASE_URL` | Postgres connection. Matches `docker-compose.yml` by default. |
| `REDIS_URL` / `REDIS_ENABLED` | Presence, queue depth and rate limiting. Published on **6380**, because 6379 is commonly taken (Dapr ships its own Redis). The API runs without Redis on a single node using in-process fallbacks. |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Two **different** long random strings. The server refuses to start in production while these are the defaults. |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | Enables Facebook Login. The secret is used server-side only, to verify tokens with `debug_token`. |
| `GOOGLE_CLIENT_ID` | Enables Google Sign-In. Only the client id is needed; ID tokens are verified against Google. |
| `ALLOW_GUEST` | Guest play. Production also requires `ALLOW_GUEST_IN_PROD=true` to confirm. |
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the API and open a socket. |

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Facebook setup

1. <https://developers.facebook.com/apps> → Create app → *Authenticate and
   request data from users with Facebook Login*.
2. **Settings → Basic**: copy App ID and App Secret into `apps/api/.env`.
3. Put the same App ID in `apps/web/.env.local` as
   `NEXT_PUBLIC_FACEBOOK_APP_ID` (public by design) and in
   `apps/mobile/app.json` under `extra.facebookAppId`.
4. **Facebook Login → Settings → Valid OAuth Redirect URIs**: add
   `http://localhost:3000`.
5. Add the Android and iOS platforms using the package name and bundle id from
   `app.json`.
6. Point the **Deauthorize callback URL** at `POST /auth/facebook/deauthorize`
   so removed permissions are recorded.

The app secret must never reach a client. The web and mobile builds only ever
carry the App ID.

---

## How the game works

### Physics

`packages/physics` is a fixed-timestep circle simulation: friction, elastic
collisions with per-body mass, cushion restitution, and pocket detection. It is
**deterministic** — the same input state always produces the same output — which
is what makes the multiplayer model work.

### The authoritative model

1. A client sends `{ pos, angle, power }` — nothing else. No positions, no
   results.
2. The server validates the shot (range, turn ownership, timing), places the
   striker itself, simulates to rest, and applies the rules.
3. The server broadcasts the shot **plus the exact launch vector** and the
   post-shot state.
4. Every client replays that shot locally with the same engine, so the animation
   is smooth and jitter-free, then snaps to the server's board.

A modified client can send a bad shot and get rejected; it cannot produce a
result. Score, fouls, winner, coins, XP and crates are only ever computed
server-side.

### Rules implemented

Queen and cover requirement, striker fouls, no-touch fouls, penalty returns,
repeat turns on a pocket, turn timeout as a foul, doubles seating with partners
opposite, the queen going to the opponent when a winner never covered it, and a
150-turn cap that decides a stalled board on men remaining.

---

## Content

Cosmetics are **drawing recipes, not images** — a record of colours, a pattern
and an animation. `packages/ui` draws them once; the web renders through canvas
and mobile through SVG. Nothing downloads, everything scales, and no cosmetic
field is ever read by the physics engine.

- **50 strikers** — 16 common, 14 rare, 10 epic, 7 mythic, 3 legendary
- **50 coin sets** — same rarity spread
- **20 boards** — each with its own frame, bed, pockets, markings, backdrop,
  ambient animation and sound pack

### Crates

| Crate | Unlock | Items | Guaranteed |
| --- | --- | --- | --- |
| Rookie | 15 min | 2 | Common |
| Champion | 3 h | 3 | Rare |
| Legendary | 8 h | 4 | Epic |

Drop rates are published in the UI and come from the same table the roll uses
(`dropTable()` in `packages/content/src/crates.ts`).

---

## Fairness and moderation

**Server-side only:** game state, turn ownership, shot validation, score, fouls,
winner, coin balance, XP, crate contents.

**Rejected at the door:** out-of-range shots, shots from the wrong seat,
non-finite numbers, shots after a match ends, shots faster than a person can
physically take.

**Signals recorded for review** (`cheat_flags`): invalid shots in a row, rapid
actions, impossibly fast turns, abnormal win rate over a meaningful sample,
multiple live sessions on one account, and a collusion scan for pairs who only
ever play each other.

None of those ban anyone. They queue an account for a person to look at.

**Reports** (`/reports`) go to the admin queue with the match attached. Opening a
report shows the account's record, recent matches, every automated flag, other
reports and their ban history. A moderator then chooses: no action, warn,
duplicate, or ban (whole account, ranked only, or chat only; temporary or
permanent). Banning revokes every active session immediately. Every decision is
written to `audit_logs` with who made it.

The coin ledger is append-only: `profiles.coins` must always equal the sum of a
user's `coin_ledger` rows, and `/admin/economy/audit` checks it.

---

## Tests

```bash
npm test
```

69 unit tests over the opening layout, physics, determinism, shot validation,
striker placement, fouls, the queen, win conditions, match termination, level
titles, the XP curve, ranked divisions, fair play and the login cycle.

The determinism test is the important one: it proves the client replay and the
server simulation cannot disagree.

With the stack running, the end-to-end suite plays a real match:

```bash
npm run test:e2e
```

46 checks covering health, guest sign-in, refresh-token rotation and reuse
detection, matchmaking, entry collection, shot rejection, a full match played
over sockets, payout arithmetic, ledger integrity, progression, the daily
calendar, double-claim prevention, reporting and admin authorisation.

The suite runs in a single process by default — the physics tests are memory
hungry and the worker pool is the first thing to fall over on a loaded machine.

---

## Scaling

The API is stateless apart from in-flight matches, which are owned by the node
holding their sockets. Everything durable is written to Postgres as it happens,
so losing a node loses only the boards it was hosting, never a balance or an
item.

Redis carries presence, queue depth and rate limiting. Matchmaking entries
record which node a player is connected to, so only that node completes a match;
with several nodes and no sticky routing this degrades to per-node matching
rather than pairing players who could never share a room. The next step for
multi-node is sticky sessions or a dedicated match-owner service plus the
Socket.IO Redis adapter.

---

## Notes from verification

Running the stack end to end turned up four real defects, all fixed:

- **Entry fees were charged before the match row existed**, so the coin ledger's
  foreign key rejected them and no match could start. The match is now persisted
  first, and a failed sit-down voids it rather than leaving a phantom row.
- **A duplicate idempotency key aborted the Postgres transaction**, so the
  follow-up read of the original result failed. Claiming now uses
  `ON CONFLICT DO NOTHING`, which leaves the transaction usable.
- **Every carrom man rendered ivory** — white and black were indistinguishable.
  A coin set defined one appearance, but a carrom set is a pair. The set now
  supplies the design and the side decides light or dark.
- **The striker stayed wherever it stopped** between turns, so the board showed a
  stranded striker while the aim guide pointed at an empty base line. It now
  parks on the current shooter's base line.

`window` also had to be renamed in `leaderboard_entries`: it is a reserved word
in Postgres.

## Known gaps

- No mail provider is wired up. Verification and password-reset links are logged
  instead of sent — see `apps/api/src/auth/routes.ts`.
- Avatar upload needs `STORAGE_BUCKET_URL` and an S3 client; provider avatars
  from Facebook and Google work today.
- Sound packs are declared per board but no audio files ship yet.
- The end-to-end socket integration test needs a live Postgres, so it is not in
  the default `npm test` run.
