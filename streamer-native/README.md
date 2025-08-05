## Mediasoup Client -> Native Screen output -> FFMPEG

```
docker run -it --rm \
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

```

## RTP -> FFMPEG

create plain transport -> transportId
connect plain transport [ ip, port, transportId ]
create consumer [producerId, transportId]

v=0
o=- 0 0 IN IP4 127.0.0.1
s=mediasoup
c=IN IP4 127.0.0.1
t=0 0
a=tool:libavformat 55.7.100
m=audio ${AUDIO_LOCAL_PORT} RTP/AVP ${AUDIO_PT}
a=rtpmap:${AUDIO_PT} opus/48000/2
m=video ${VIDEO_LOCAL_PORT} RTP/AVP ${VIDEO_PT}
a=rtpmap:${VIDEO_PT} VP8/90000

PLAN

1. Connect to signaling server using websocker
2. Get producers list create new Set()
3. assign a unique udp port to each producer
4. create plain consumer for each producer using their port
5. generate a multi track sdp
6. generate a ffmpeg filter complex for that sdp
7. generate hls
