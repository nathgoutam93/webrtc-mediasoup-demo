# Mediasoup Video Conferencing + HLS Streaming Demo

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
