# PhoneConf

A WebRTC audio conference app for your local network. Create or join a room from any device — including mobile — and talk hands-free.

## Features

- Multi-participant audio via WebRTC (peer-to-peer)
- 3-digit room codes for easy sharing
- HTTPS with auto-generated self-signed certificate (required for mic on mobile)
- QR code printed on startup — scan with your phone to join instantly
- Mute, speaker/earpiece toggle, voice-activity visualization

## Getting Started

Install dependencies:

```bash
npm install
```

Start the server:

```bash
npm start
```

On startup the server prints a QR code pointing to `https://<your-LAN-IP>:3000`. Scan it with your phone, accept the certificate warning once, and the microphone will work.

For development with hot reload:

```bash
npm run dev
```

## HTTPS

Microphone access requires a secure origin. The server automatically generates a self-signed certificate on first run and saves it to `.ssl/`. The certificate is reused on subsequent restarts — no manual steps needed.

To use your own certificate instead, set environment variables before starting:

```bash
SSL_KEY=path/to/key.pem SSL_CERT=path/to/cert.pem npm start
```

The server also starts an HTTP listener on port 80 that redirects to HTTPS. If port 80 is unavailable it logs a warning and continues.

## Using the App

1. **Create a room** — click "Create Room". A 3-digit code is assigned.
2. **Share the code** — copy it or have others scan the QR code on screen.
3. **Join a room** — enter the 3-digit code on another device and tap "Join".

## Project Structure

```
server.js       — Express + WebSocket signaling server, HTTPS setup
public/
  index.html    — UI shell
  app.js        — WebRTC, signaling, audio, UI logic
  style.css     — Styles
.ssl/           — Auto-generated certificate (gitignored)
```
