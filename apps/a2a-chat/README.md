# A2A Chat App (iOS / Android / Web)

Separate React app built with Expo + React Native that connects to OpenClaw Gateway over WebSocket.

## Features

- Single codebase for iOS, Android, and web.
- Manual connect/disconnect to Gateway WS.
- Loads transcript via `chat.history`.
- Sends user messages via `chat.send`.
- Streams assistant output from `chat` events.

## Configure

Set optional environment variables in an `.env` file:

```bash
EXPO_PUBLIC_A2A_WS_URL=ws://127.0.0.1:18789
EXPO_PUBLIC_A2A_TOKEN=
EXPO_PUBLIC_A2A_SESSION_KEY=main
```

`EXPO_PUBLIC_*` values are exposed to the app at build/runtime by Expo.

## Run

```bash
cd apps/a2a-chat
npm run start
```

Then press:

- `i` for iOS simulator
- `a` for Android emulator/device
- `w` for web

Or run directly:

```bash
npm run ios
npm run android
npm run web
```

## Notes

- Gateway auth is typically required. Provide a token in the input field or with `EXPO_PUBLIC_A2A_TOKEN`.
- The app uses the Gateway frame protocol (`req`/`res`/`event`) and sends `connect` first.
