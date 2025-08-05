FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

RUN apt-get update && apt-get install -y \
    xvfb \
    x11-utils \
    pulseaudio \
    ffmpeg \
    x11vnc \
    chromium \
    fonts-liberation \
    xfonts-base xfonts-100dpi xfonts-75dpi \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./start.sh /app/start.sh
RUN chmod +x /app/start.sh

ENTRYPOINT ["/app/start.sh"]
