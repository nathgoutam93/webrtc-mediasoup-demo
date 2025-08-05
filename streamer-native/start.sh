#!/bin/bash
set -e

URL=$1
SCREEN_RES="${2:-1280x720}"
FRAMERATE="${3:-25}"

if [ -z "$URL" ]; then
  echo "Usage: $0 URL [RESOLUTION] [FRAMERATE]"
  exit 1
fi

HLS_DIR="/app/hls/${ROOMID}"
HLS_PLAYLIST="$HLS_DIR/stream.m3u8"
mkdir -p "$HLS_DIR"
rm -rf "$HLS_DIR"/*

# Start Xvfb
Xvfb :99 -screen 0 ${SCREEN_RES}x24 &
export DISPLAY=:99

# Wait for Xvfb
for i in {1..10}; do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    echo "✅ Xvfb is ready"
    break
  fi
  sleep 0.5
done

# Start PulseAudio
pulseaudio --start
pactl load-module module-null-sink sink_name=VirtualSink sink_properties=device.description=VirtualSink


# Start Chromium in fullscreen app mode
chromium \
  --autoplay-policy=no-user-gesture-required \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-software-rasterizer \
  --use-gl=egl \
  --start-fullscreen \
  --disable-infobars \
  --test-type \
  --window-size=${SCREEN_RES/x/,} \
  --force-device-scale-factor=1 \
  --alsa-output-device=VirtualSink.monitor \
  --app=${URL} &

# Give Chromium a moment to paint
sleep 5

# Start FFmpeg capture
ffmpeg \
  -video_size "$SCREEN_RES" \
  -framerate "$FRAMERATE" \
  -f x11grab -i :99 \
  -f pulse -i VirtualSink.monitor \
  -c:v libx264 -preset ultrafast -tune zerolatency -crf 28 \
  -c:a aac -b:a 96k \
  -g $(($FRAMERATE * 2)) \
  -sc_threshold 0 \
  -f hls \
  -hls_time 1 \
  -hls_list_size 6 \
  -hls_flags delete_segments \
  "$HLS_PLAYLIST"
