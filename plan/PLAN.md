# PetCam — Build Plan

> **Goal:** Two phones, one app. Old Android stays home and streams live video.
> You connect remotely on demand. Private, free, no cloud middleman for video.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| App framework | **React Native (Expo bare workflow)** | Single codebase, three modes, runs on old Android; bare workflow required for `react-native-webrtc` and foreground service |
| Auth | **Firebase Auth** (Google Sign-In) | Free, no passwords to manage |
| Signaling + control | **Firebase Realtime DB** | Tiny messages only (~2 KB/session), free tier |
| Notifications | **Firebase Cloud Messaging (FCM)** | Push to admin when a viewer connects |
| Video | **WebRTC (P2P)** | Video is E2E encrypted (DTLS-SRTP), never touches any server |
| NAT traversal | **Google STUN** | Free, works on ~85% of networks |

---

## App modes

Same APK on every device. Role picked once on first launch, stored locally.
Admin is detected automatically — if your UID matches `/admin/uid` in Firebase, the admin UI appears on top of the viewer UI.

| Mode | Device | Behavior |
|---|---|---|
| **Home** | Old Android, plugged in | Foreground service keeps camera alive, listens for viewer connections |
| **Viewer** | Any phone | Sign in → Connect → watch live |

---

## Network / privacy model

The home phone **reaches out** to Firebase — Firebase never reaches into your network.

```
Home phone  ──→  Firebase (cloud)  ←──  Your phone (viewer/admin)
```

- Home phone opens a persistent outbound HTTPS/WebSocket connection to Firebase
- No port forwarding, no router configuration, no exposed ports
- WebRTC video is also outbound from both sides (STUN punch-through)
- Video is encrypted end-to-end (DTLS-SRTP) — mandatory in the WebRTC spec, can't be disabled
- Signaling metadata (SDP/ICE) passes through Firebase over HTTPS — encrypted in transit, but not video

---

## User flow

### Home phone (one-time setup)
1. Install APK
2. Sign in with Google
3. Pick **Home** mode
4. Foreground service starts
5. Writes one timestamp to `/heartbeat` (so admin can see "Online since HH:MM")
6. Listens on Firebase for viewer connections and admin commands

### Viewer connecting
1. Install APK
2. Sign in with Google
3. Firebase whitelist checked → allowed?
4. Tap **Watch**
5. WebRTC signaling over Firebase Realtime DB
6. P2P encrypted video established
7. Home phone reads `/admin/fcm_token` and sends FCM push directly via HTTP v1 API: *"[email] connected at HH:MM"*

### Admin actions
- **Audit list** — see who is currently connected and since when
- **Terminate viewer** — boot a specific viewer; home phone kicks them, stream drops
- **Restart app** — home phone restarts its foreground service (useful if camera freezes)
- **Shutdown** — home phone stops the service and releases the camera

---

## Screens

| Screen | Who sees it | Notes |
|---|---|---|
| Sign in | Everyone | Google OAuth |
| Role picker | Everyone | First launch only |
| Home mode | Home phone | "Active — streaming since HH:MM" + Stop |
| Viewer mode | Everyone | Connect button → fullscreen video |

---

## Firebase DB schema

```
/admin
  uid: "<your-uid>"           ← set once in Firebase console
  fcm_token: "<token>"        ← updated by admin device on each launch

/home
  uid: "<home-phone-uid>"     ← set once in Firebase console

/whitelist
  <uid>: true

/sessions
  <viewer-uid>              ← one slot per viewer, keyed by their UID
    offer: <SDP>
    answer: <SDP>
    ice_home: [...]
    ice_viewer: [...]
    viewer_email: "<email>"
    started_at: <timestamp>

/commands/pending
  cmd: "restart"|"shutdown"|"kick"
  target_uid: "<uid>"         ← for kick only
  ts: <timestamp>
  issued_by: "<admin-uid>"

/heartbeat
  ts: <timestamp>             ← written once when home service starts

/log
  <push-id>:
    uid, email, event ("connected"|"disconnected"|"blocked"), ts
```

---

## Firebase security rules (draft)

```json
{
  "rules": {
    "admin": {
      ".read":  "auth != null && auth.uid === data.child('uid').val()",
      ".write": "auth != null && auth.uid === data.child('uid').val()"
    },
    "whitelist": {
      ".read":  "auth != null",
      ".write": false
    },
    "sessions": {
      ".read":  "auth != null && (root.child('whitelist').child(auth.uid).exists() || auth.uid === root.child('admin/uid').val())",
      ".write": "auth != null && (root.child('whitelist').child(auth.uid).exists() || auth.uid === root.child('admin/uid').val())"
    },
    "commands": {
      ".read":  "auth != null && (auth.uid === root.child('admin/uid').val() || auth.uid === root.child('home/uid').val())",
      ".write": "auth != null && auth.uid === root.child('admin/uid').val()"
    },
    "heartbeat": {
      ".read":  "auth != null && auth.uid === root.child('admin/uid').val()",
      ".write": "auth != null && auth.uid === root.child('home/uid').val()"
    },
    "home": {
      ".read":  false,
      ".write": false
    },
    "log": {
      ".read":  "auth != null && auth.uid === root.child('admin/uid').val()",
      ".write": "auth != null && (root.child('whitelist').child(auth.uid).exists() || auth.uid === root.child('admin/uid').val())"
    }
  }
}
```

---

## Security

- Google auth required — zero anonymous access
- Whitelist enforced server-side by Firebase rules
- Admin UID hardcoded in DB — cannot be claimed by any other account
- Commands writable only by admin UID
- Audit log readable only by admin UID
- Home phone ignores commands older than 60s (replay protection)
- Video encrypted end-to-end (DTLS-SRTP, mandatory WebRTC)
- No recording on home phone — viewer can screen-record locally if needed
- Wake lock + foreground service: screen can be off, camera stays alive
- Auto-restart foreground service if Android kills it

---

## Build order

### Phase 1 — Firebase + Auth
- [ ] Create Firebase project
- [ ] Enable Google Sign-In
- [ ] Add `google-services.json`
- [ ] Sign-in screen working on a real device
- [ ] Set your UID as `/admin/uid` in Firebase console
- [ ] Set home phone's UID as `/home/uid` in Firebase console

### Phase 2 — Whitelist + DB rules
- [ ] Write security rules (draft above)
- [ ] Add yourself + family to whitelist
- [ ] Verify rule enforcement (unlisted account → blocked, event written to `/log`)

### Phase 3 — WebRTC signaling
- [ ] Add `react-native-webrtc`
- [ ] Offer/answer + ICE candidate exchange over Firebase
- [ ] P2P video working on same Wi-Fi
- [ ] P2P video working across networks (mobile data ↔ home Wi-Fi)

### Phase 4 — Android foreground service
- [ ] Foreground service survives screen-off
- [ ] Wake lock
- [ ] Auto-restart on kill
- [ ] Write `/heartbeat` timestamp on service start
- [ ] Listen for `/commands/pending` → handle restart, shutdown, kick

### ~~Phase 5 — Admin panel~~ (dropped)
> All admin actions handled directly via Firebase console. No app UI needed.

### Phase 5 — FCM notifications
- [ ] FCM setup in Firebase + app
- [ ] Admin device token saved to `/admin/fcm_token` on launch
- [ ] Home phone sends FCM directly via HTTP v1 API (no Cloud Function — stays on Spark free plan; service account key bundled in app)

### Phase 6 — UI polish
- [ ] Home mode status screen
- [ ] Viewer fullscreen + reconnect button

---

## Open questions

- **TURN server:** STUN works ~85% of networks. If P2P fails on strict NAT (some mobile carriers, office Wi-Fi), options: Oracle Cloud free-tier VM (self-hosted coturn), or [Open Relay](https://www.metered.ca/tools/openrelay/) (free, rate-limited). Revisit after real-world testing.
- **Multiple concurrent viewers:** Admin watching + family viewer = two simultaneous streams. Schema already supports it (keyed sessions). Home phone opens one peer connection per viewer-UID child. Needs load testing; defer full support until basic flow works.

---

## Dev environment

- VS Code + Claude Code
- Expo CLI for React Native (bare workflow — init with `npx create-expo-app pettv --template bare-minimum`)
- Android device for testing (emulator won't do — real camera needed)
- Firebase console for DB + rules management

---

*Last updated: 2026-11-20 — blockers resolved: bare workflow, FCM via HTTP v1 (no Cloud Functions), sessions keyed by viewer UID; security rules tightened: heartbeat write restricted to home UID, commands read restricted to admin + home UID*
