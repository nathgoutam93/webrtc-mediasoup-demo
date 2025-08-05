import HlsPlayer from "@/components/hls-player";

export default function WatchPage() {
  const roomId = "test-room";
  const stream = `http://localhost:8000/live//stream.m3u8`;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900">
      <HlsPlayer src={stream} controls autoPlay width={800} height={450} />
    </div>
  );
}
