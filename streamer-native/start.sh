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

# Start Xvfb (headless display)
Xvfb :99 -screen 0 ${SCREEN_RES}x24 -nocursor +extension RANDR &
export DISPLAY=:99

# Wait for Xvfb to be ready
for i in {1..10}; do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    echo "✅ Xvfb is ready"
    break
  fi
  sleep 0.5
done

# Start PulseAudio
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=VirtualSink sink_properties=device.description=VirtualSink >/dev/null

# Start Chromium in fullscreen mode
chromium \
  --autoplay-policy=no-user-gesture-required \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-software-rasterizer \
  --use-gl=egl \
  --enable-gpu \
  --ignore-gpu-blocklist \
  --disable-gpu-vsync \
  --enable-zero-copy \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-infobars \
  --test-type \
  --start-maximized \
  --kiosk \
  --window-position=0,0 \
  --window-size=${SCREEN_RES/x/,} \
  --alsa-output-device=VirtualSink.monitor \
  --app=${URL} &

# Wait for Chromium to load enough to render
sleep 5

# Start FFmpeg capture (full DVR mode, no deletes)
ffmpeg \
  -video_size "$SCREEN_RES" \
  -framerate "$FRAMERATE" \
  -thread_queue_size 512 -f x11grab -i :99 \
  -thread_queue_size 512 -f pulse -i VirtualSink.monitor \
  -c:v libx264 -preset ultrafast -crf 30 \
  -c:a aac -b:a 96k \
  -g $(($FRAMERATE * 4)) \
  -sc_threshold 0 \
  -f hls \
  -hls_time 4 \
  -hls_list_size 0 \
  -hls_flags append_list \
  -hls_segment_filename "$HLS_DIR/stream_%05d.ts" \
  "$HLS_PLAYLIST"
