import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900">
      <div className="flex gap-6">
        <Link href="/stream" >
          <span className="px-8 py-4 bg-blue-600 text-white rounded-lg text-xl shadow hover:bg-blue-700 transition-colors">Join Room</span>
        </Link>
        <Link href="/watch">
          <span className="px-8 py-4 bg-green-600 text-white rounded-lg text-xl shadow hover:bg-green-700 transition-colors">Watch Only</span>
        </Link>
      </div>
    </div>
  );
}
