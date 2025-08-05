import { useEffect, useRef, useState } from "react";

export default function RemoteVideo({
  peerId,
  displayName,
  stream,
  subscriptions,
  onToggleAudio,
  onToggleVideo,
}: {
  peerId: string;
  displayName: string;
  stream: MediaStream;
  subscriptions: Record<string, { audio: boolean; video: boolean }>;
  onToggleAudio: (peerId: string) => void;
  onToggleVideo: (peerId: string) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const videoEl = ref.current;
    if (!videoEl || !stream) return;

    if (videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
      videoEl.play().catch(console.error);
    }
  }, [stream]);

  const isCameraOn =
    stream.getVideoTracks().length > 0 && subscriptions[peerId]?.video;

  return (
    <div className="relative w-full h-full bg-gray-800 rounded-lg overflow-hidden isolate">
      <video
        ref={ref}
        autoPlay
        playsInline
        className="relative w-full h-full object-cover"
        style={{ display: isCameraOn ? "block" : "none" }}
      />

      {!isCameraOn && (
        <div className="w-full h-full flex items-center justify-center bg-gray-700">
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-gray-500 flex items-center justify-center mx-auto mb-2 text-3xl text-white font-bold">
              {displayName?.[0]?.toUpperCase() || "?"}
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-2 left-2 bg-black bg-opacity-70 text-white px-2 py-1 rounded text-xs font-medium">
        {displayName}
      </div>

      <div className="absolute top-1 right-1 flex gap-1 z-50">
        <button
          onClick={() => onToggleAudio(peerId)}
          className="p-1 bg-white/20 rounded"
        >
          Audio
        </button>
        <button
          onClick={() => onToggleVideo(peerId)}
          className="p-1 bg-white/20 rounded"
        >
          Video
        </button>
      </div>
    </div>
  );
}
