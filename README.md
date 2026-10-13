# Qadā’ — Umri Namaz Tracker

A private, offline-first PWA for making up a lifetime of missed (qaza) prayers: Fajr, Zuhr, Asr, Maghrib, Isha, and Witr.

No accounts. No backend. No analytics. All data stays on-device in IndexedDB.

## Features

- **Onboarding** — estimate the debt from age of bulūgh (minus years prayed), or enter exact per-prayer counts. Witr toggle. Everything editable later. The calculator is labeled as an estimate only.
- **Fast logging** — one-tap +1 per prayer (thumb-zone, 44px+ targets), +5, "full day" shortcut, bulk add, and undo for everything via snackbar + per-item history.
- **Journey stats** — per-prayer progress rings, overall %, current/best streak, 7/30-day pace, projected completion date, 16-week calendar heatmap, weekly/monthly trends, quiet milestone moments.
- **Settings** — adjust remaining counts, light/system/dark themes, JSON export/import backup, guarded reset.
- **Persistence** — append-only event log in versioned IndexedDB; all stats derived, so undo/edits stay consistent. `navigator.storage.persist()` requested.
- **PWA** — manifest, maskable icons, precache + runtime service worker with update prompt, iOS install meta, fully offline.

## Run locally

Any static server works:

```sh
python3 -m http.server 8901
# → http://localhost:8901/index.html
```

## Tech

Vanilla HTML/CSS/JS — zero dependencies, zero network requests. Self-hosted fonts (Newsreader, Outfit, Amiri) precached by the service worker.

## Privacy

There is deliberately no way for data to leave the device: no fetch calls except same-origin cacheable assets, no analytics, no accounts. Backup is a user-initiated JSON download.
