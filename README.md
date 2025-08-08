# Mediasoup Video Conferencing + HLS Streaming Demo

This is a demo implementation of a Mediasoup‑based SFU for real‑time video conferencing, integrated with HLS streaming for broadcasting live sessions to large audiences.
It uses Node.js for the SFU server, and a lightweight Docker‑based streamer that captures the session and convert to HLS in real time.

## Key Features

- Real‑time conferencing using Mediasoup SFU.
- HLS streaming for scalable viewer distribution.
- Docker‑based architecture for easy deployment and isolation.
- client built with modern web technologies.
- Simple setup: run both SFU and HLS streamer with a few commands.

## Planned Features

- Auto spin‑up/down HLS streamer for each unique session
- Automatically create and stop a dedicated hls-streamer container for each active room.
- Audio observer for speaker detection
  - Detect active speaker using Mediasoup’s audio observer API.
  - Highlight the person speaking and keep them in the top position in the UI.
- Simulcast support
  - Automatically switch to highest quality for active speaker, lower quality for others.
- UI improvements
  - Better participant layout.
  - Real‑time speaker indication.
  - Improved mobile responsiveness.

## Setup and Installation

### requirements

1. nodejs
2. docker ( required for streaming )

### Installaion and build

```
npm i

docker build . -t server

cd streamer-native
docker build . -t streamer

cd ..

```

### RUN

```
docker run -itd --rm \
  --name sfu-server \
  -v /tmp/hls:/tmp/hls \
  -e LISTEN_PORT="8000" \
  -e MEDIASOUP_LISTEN_IP="0.0.0.0" \
  -e MEDIASOUP_ANNOUNCED_IP="$(ipconfig getifaddr en0)" \
  -p 40000-40200:40000-40200/udp \
  -p 8000:8000 \
  server


docker run -it --rm \
  --name hls-streamer \
  -v /tmp/hls:/app/hls \
  streamer "http://$(ipconfig getifaddr en0):8000/preview?roomId=test-room"


npm run dev -- --filter=client

```
