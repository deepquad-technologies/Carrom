# Running it locally

## The short version

Start Docker Desktop, then:

```bash
npm run dev
```

That brings up Postgres and Redis, then runs the API and the web app together.
Open **http://localhost:3000** and press *Play now as guest* — no sign-up, no
configuration.

To stop the containers when you are done:

```bash
npm run stop
```

Add the admin dashboard as well:

```bash
npm run dev:all
```

Everything below is for running the pieces separately, which is easier to read
when you are debugging one of them.

---

## Individually

### Database and cache

```bash
npm run docker:up
```

Postgres on **5432**, Redis on **6380**. Redis avoids the usual 6379 because
Dapr — from your Nevada work — already holds that port.

```bash
docker ps --filter name=carrom
```

### API

```bash
npm run dev:api
```

**http://localhost:4000**. Migrations and the content seed apply automatically on
boot, so a fresh database needs nothing extra. Wait for `carrom api ready`. If it
says *Cannot reach Postgres*, the containers are not up yet.

### Web

```bash
npm run dev:web
```

**http://localhost:3000**.

From your phone on the same network, use **http://172.20.10.2:3000** instead.
That address is already in `CORS_ORIGINS`, so the API will accept it.

---

### Mobile

The quickest way to see it is in a browser — the same React Native components
and the same SVG board, no device needed:

```bash
npm run dev:mobile:web
```

**http://localhost:8081**.

For a real device:

```bash
npm run dev:mobile
```

That starts Expo and prints a QR code.

- **On a phone**: install *Expo Go* from the App Store or Play Store, then scan
  the QR code. The phone must be on the same Wi-Fi as this machine.
- **Android emulator**: press `a` in the Expo terminal.
- **iOS simulator** (macOS only): press `i`.

`apps/mobile/app.json` already points at `http://172.20.10.2:4000`. If your
network address changes, update `expo.extra.apiUrl` there and add the new
address to `CORS_ORIGINS` in `apps/api/.env`.

> `localhost` will not work from a phone — it means the phone itself. The LAN
> address is required.

---

### Admin dashboard

```bash
npm run dev:admin
```

**http://localhost:3001**. Needs an account with the `moderator` or `admin`
role — see below.

---

## Ports at a glance

| Port | What |
| --- | --- |
| 3000 | Web app |
| 3001 | Admin dashboard |
| 4000 | API |
| 5432 | Postgres |
| 6380 | Redis |
| 8081 | Mobile app (Expo) |

---

## Making yourself an admin

Sign up on the web app with an email, then promote that account:

```bash
docker exec carrom-postgres psql -U carrom -d carrom -c "UPDATE users SET role='admin' WHERE email='you@example.com';"
```

Sign out and back in on the admin app.

---

## Looking at the data

pgAdmin, or any SQL client:

| Field | Value |
| --- | --- |
| Host | `localhost` |
| Port | `5432` |
| Database | `carrom` |
| Username | `carrom` |
| Password | `carrom` |

In pgAdmin the tables are under **carrom → Schemas → public → Tables**, not
directly under the database.

Or straight from the container:

```bash
docker exec -it carrom-postgres psql -U carrom -d carrom
```

---

## Tests

```bash
npm test
```

Unit tests — physics, rules, progression. No database needed.

```bash
npm run test:e2e
```

End-to-end. Needs the API running. Signs two players in, plays a real match over
sockets and checks the payouts, the ledger and the progression.

---

## When something is wrong

**Port already in use.** Find what holds it:

```bash
netstat -ano | findstr :4000 | findstr LISTENING
```

The last number on that line is the process id; stop it with
`taskkill /PID <pid> /F`. Same for 3000, 3001 and 8081.

A stale server from an earlier session is the usual cause, and the symptom is
always `EADDRINUSE`.

**Web is slow to load or fails to compile.** Usually memory pressure. Clear the
build cache and restart:

```bash
rm -rf apps/web/.next/cache
```

Closing spare VS Code windows and stopping the unused SQL Server instance
(`net stop MSSQLSERVER`) both help noticeably on this machine.

**Phone cannot reach the API.** Confirm the address is still right:

```bash
ipconfig | grep IPv4
```

Ignore the `172.22.x` and `172.25.x` addresses — those are WSL and Hyper-V
virtual adapters, not your real network. Windows Firewall may also prompt the
first time a phone connects; allow it on private networks.
