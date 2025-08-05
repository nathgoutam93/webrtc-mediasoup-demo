'use client'

import React, { useEffect, useRef } from 'react';

// To use this component, install hls.js: npm install hls.js
import Hls from 'hls.js';

interface HlsPlayerProps {
  src: string;
  autoPlay?: boolean;
  controls?: boolean;
  width?: string | number;
  height?: string | number;
  poster?: string;
  muted?: boolean;
  className?: string;
}

const HlsPlayer: React.FC<HlsPlayerProps> = ({
  src,
  autoPlay = true,
  controls = true,
  width = '100%',
  height = 'auto',
  poster,
  muted = false,
  className = '',
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari, iOS)
      video.src = src;
    } else if (Hls.isSupported()) {
      // Hls.js fallback
      const hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => {
        hls.destroy();
      };
    }
  }, [src]);

  return (
    <video
      ref={videoRef}
      autoPlay={autoPlay}
      controls={controls}
      width={width}
      height={height}
      poster={poster}
      muted={muted}
      className={className}
      style={{ background: '#000' }}
    />
  );
};

export default HlsPlayer;
