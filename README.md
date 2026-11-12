# SubTrack – CRUD with server integration (React Native / Expo + SQLite + own REST server)

**SubTrack**, a subscription & bills tracker (see the
[project idea](https://github.com/ma-cs-ubbcluj-ro/ma2026-project-idea-gabor-gabriel)), extended from the
[local database app](https://github.com/ma-cs-ubbcluj-ro/ma2026-local-db-gabor-gabriel): every CRUD operation now goes to
**our own REST server** (Node.js, in [`server/`](server)), the local SQLite database is kept as an offline copy, and a
**WebSocket** pushes the server's changes to the app. No cloud service is used.

## The server (`server/`)

Plain Node.js (`node:http`) + [`ws`](https://github.com/websockets/ws) for the WebSocket. Data is stored in
`server/data/subscriptions.json` (created and seeded with six demo subscriptions on the first start; ids come from a
counter in the same file and are never reused).

| Method | Path | Body | Answer |
|---|---|---|---|
| `GET` | `/subscriptions` | – | `200` every subscription, sorted by next payment date |
| `GET` | `/subscriptions/:id` | – | `200` one subscription · `404` |
| `POST` | `/subscriptions` | the new element **without id** | `201` stored element, **id assigned by the server** (an id in the body is ignored) · `400` |
| `PUT` | `/subscriptions/:id` | every field | `200` the same element, **updated in place, same id** · `400` · `404` |
| `DELETE` | `/subscriptions/:id` | – (**only the id**, in the URL) | `204` · `404` |
| WS | `/ws` | – | `{"type":"created"\|"updated","subscription":{…}}` / `{"type":"deleted","id":7}`, plus `origin` |

- Every body is validated with the same rules as the form; errors are `{"error":{"code","message","fields"}}`.
- The app sends `X-Client-Id`; the server echoes it as `origin` in the WebSocket message so the app skips the echo of
  its own changes.
- **Logs**: every request (`--> POST /subscriptions (client …)` / `<-- … 201 (7 ms)`), every operation
  (`CREATE id=7 "Netflix"`, `UPDATE`, `DELETE`, `READ`), every rejection with its reason, WebSocket connects /
  disconnects and every broadcast, with timestamps.
- `DELAY_MS=1500 npm start` adds artificial latency, to show the progress indicators in a demo.

## The app

```
screen ──► SubscriptionViewModel ──► SubscriptionRepository ──┬──► SubscriptionApi (HTTP, fetch) ──► REST server
                                     (cache, sync, offline    ├──► ServerEventSource (WebSocket) ◄── server changes
                                      queue, one op at a time) └──► SubscriptionDao ──► SQLite (expo-sqlite)
```

### CRUD

| Operation | Online | Offline | Errors |
|---|---|---|---|
| **Read** (`src/app/index.tsx`) | Local rows are read **once** at start and kept in memory while the app is alive. When the WebSocket connects, pending changes are pushed and the server list is downloaded **once** to refresh the local copy; after that, the server's changes arrive over the **WebSocket**, one element at a time (no re-reads). The list is downloaded again only after the connection was lost, as changes may have been missed. | The list comes from the local database; a banner says *“Offline – changes will sync when you're back online”* with *“Last synced: today, 14:32”* and the number of changes waiting. | Local read errors: banner + Retry. Sync errors: banner + Retry. |
| **Create** (`src/app/create.tsx`) | Only the new element is `POST`ed; the server assigns the id, then the element is stored locally with that server id. | Stored locally as *pending create* (marked “Not synced” in the list), `POST`ed after reconnecting; the server id is then stored. | Shown on the form with a friendly message; the form keeps the input. |
| **Update** (`src/app/update/[id].tsx`) | `PUT /subscriptions/{serverId}` with every field; the server element and the local row are updated in place, ids never change. | Stored locally as *pending update*, `PUT` after reconnecting. Editing an element not sent yet just changes the pending create. | Shown on the form; if it was deleted on another device: *“This subscription no longer exists…”*. |
| **Delete** (`src/app/delete/[id].tsx`) | `DELETE /subscriptions/{serverId}` – only the id; then the local row is removed. | Removed locally and the server id is queued (same transaction), `DELETE`d after reconnecting. An element created offline and never sent is just removed, nothing is sent. | Logged and shown inside the confirmation dialog, which stays open. |

The user never sees an id: the app uses the local row id as its key and keeps the server id (`server_id`) next to it.
Conflicts: when the same element was changed offline here and on another device, the local change is sent and wins
(the most recent change). A local change to an element deleted on the server is dropped.

### Errors, threads and logs

- **Friendly errors** (`friendlyError` in `src/util/log.ts`): the screen shows what failed (*“Could not save the
  changes.”*) and a plain reason (*“The server cannot be reached…”*, *“The server did not accept these values: Name.”*,
  *“The server ran into a problem…”*, *“Your phone could not access the saved data…”*). Raw messages are only logged.
- **Off the UI thread**: every network and database call is asynchronous (`fetch`, WebSocket, `expo-sqlite` async API)
  and awaited in the repository; requests have a 6 s timeout. Repository operations run one at a time through a promise
  queue, so a sync never interleaves with a user's change.
- **Debug logs**: every client operation is logged with `console.log` / `console.error` (Metro terminal / logcat),
  tagged `[SubTrack] API`, `WS`, `DB`, `Repository`, `Sync`, `ViewModel`.

### Local database (`subtrack.db`)

Schema version 2 (migrated from the local-db assignment in `src/data/SqliteSubscriptionDao.ts`):
`subscriptions` gains `server_id` (unique, `NULL` until the server stored it) and `sync_state`
(`SYNCED` / `PENDING_CREATE` / `PENDING_UPDATE`); `pending_deletes(server_id)` holds deletes made offline;
`sync_meta` stores the last sync time. Rows from the local-only version are uploaded as new on the first sync.
A new install starts empty and gets its data from the server.

### Project layout

```
server/                           REST + WebSocket server
├── src/index.js                  entry point (PORT, DATA_FILE, DELAY_MS)
├── src/app.js                    routes, validation errors, WebSocket broadcast, request logs
├── src/store.js                  JSON file storage, server-side ids
├── src/validation.js             field rules
└── test/server.test.js           node:test API + WebSocket tests
src/
├── app/                          Expo Router screens (list, create, update, delete dialog)
├── data/
│   ├── SubscriptionRepository.ts cache, online/offline writes, sync, server events
│   ├── SubscriptionApi.ts        REST client (fetch + timeout, error mapping)
│   ├── ServerEvents.ts           WebSocket listener with reconnect
│   ├── serverConfig.ts           server URL
│   ├── SqliteSubscriptionDao.ts  SQLite schema, migrations, queries
│   └── errors.ts                 NetworkError / ServerError
├── ui/                           view model, shared form, components (SyncStatus, SubscriptionItem, …)
└── util/                         dates, money, validation, logging + friendly errors
__tests__/                        Jest tests (repository online/offline/sync, REST client, WebSocket, DAO)
```

## Build & run

Requirements: Node.js 18+, and the **Expo Go** app (SDK 52) on a phone in the same Wi-Fi as the computer, or an
Android emulator.

```bash
npm install                 # app dependencies
npm --prefix server install # server dependencies
npm run server              # start the server on port 3000 (prints its LAN addresses)
npm start                   # in a second terminal: start Expo, scan the QR code with Expo Go
```

The app looks for the server on the computer that runs Expo (the host of the Metro URL), port 3000. To use another
address, put `EXPO_PUBLIC_SERVER_URL=http://192.168.1.20:3000` in `.env.local` and restart Expo. Allow Node.js through
the Windows firewall on private networks if the phone cannot connect.

```bash
npm test                    # app unit tests
npm run test:server         # server tests
npm run typecheck           # TypeScript check
```

**Demo of offline mode**: stop the server (Ctrl+C) – the banner turns to *Offline*; add, edit and delete
subscriptions (they show *Not synced*); start the server again – the app reconnects within a few seconds, sends the
changes (see the server log) and the marks disappear. Open the app on a second device to see changes arrive over the
WebSocket. To start from the demo data again, stop the server and delete `server/data/subscriptions.json`.
