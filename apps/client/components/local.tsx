import { useEffect, useRef } from "react";

export default function LocalVideo({ stream, displayName, isCameraOn }: { stream: MediaStream; displayName: string; isCameraOn: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const videoEl = ref.current;
    if (!videoEl || !stream) return;
    if (videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
      videoEl.play().catch(() => {});
    }
  }, [stream]);

  return (
    <div className="relative w-full h-full bg-gray-800 rounded-lg overflow-hidden">
      <video
        ref={ref}
        autoPlay
        muted
        playsInline
        className="w-full h-full object-cover"
        style={{ display: isCameraOn ? 'block' : 'none' }}
      />
      {!isCameraOn && (
        <div className="w-full h-full flex items-center justify-center bg-gray-700">
          <div className="text-center">
            <svg className="w-16 h-16 text-gray-400 mx-auto mb-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 00-1.06 1.06l14.5 14.5a.75.75 0 101.06-1.06L3.28 2.22zM6.31 5.37L4.5 3.56A2 2 0 004 4v8a2 2 0 002 2h6c.37 0 .7-.1.99-.27L9.69 10.5H6V6.31zM14 8.5V7a1 1 0 00-1.447-.894L11 6.5v1.69l3 3V8.5z" clipRule="evenodd" />
            </svg>
            <p className="text-gray-400 text-sm">Camera off</p>
          </div>
        </div>
      )}
      <div className="absolute bottom-2 left-2 bg-black bg-opacity-70 text-white px-2 py-1 rounded text-xs font-medium">
        You ({displayName})
      </div>
    </div>
  );
}