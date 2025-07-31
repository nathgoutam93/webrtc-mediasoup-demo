//@ts-nocheck
// stream.js
import puppeteer from "puppeteer";
import { spawn } from "child_process";
import express from "express";
import cors from 'cors';
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const roomId = process.argv[2];
const PORT = parseInt(process.argv[3], 10);
if (!roomId || isNaN(PORT)) {
    console.error("Usage: node stream.js <roomId> <port>");
    process.exit(1);
}
const PREVIEW_HOST = process.env.PREVIEW_HOST || "localhost";
const PREVIEW_PORT = process.env.PREVIEW_PORT || 8000;
const PREVIEW_URL = `http://${PREVIEW_HOST}:${PREVIEW_PORT}/preview?roomId=${roomId}`;
const OUT_DIR = join(__dirname, "..", "public", "hls", roomId);
fs.mkdirSync(OUT_DIR, { recursive: true });
// Serve HLS
const app = express();
app.use(cors());
app.use("/live", express.static(OUT_DIR));
app.listen(PORT, () => console.log(`[${roomId}] HLS available at http://localhost:${PORT}/live/stream.m3u8`));
// FFmpeg process
const ffmpeg = spawn("ffmpeg", [
    "-y",
    "-fflags", "+genpts",
    "-use_wallclock_as_timestamps", "1",
    "-vsync", "1",
    "-async", "1",
    // Video input from Puppeteer
    "-f", "image2pipe",
    "-framerate", "25",
    "-i", "pipe:3",
    // Audio input from MediaRecorder
    "-f", "webm",
    "-c:a", "libopus", // decode correctly
    "-i", "pipe:4",
    // Encoding
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    // Avoid hanging if one input stops first
    "-shortest",
    // HLS output
    "-f", "hls",
    "-hls_time", "2",
    "-hls_list_size", "5",
    "-hls_flags", "delete_segments+append_list",
    "-hls_segment_filename", join(OUT_DIR, "segment_%03d.ts"),
    join(OUT_DIR, "stream.m3u8")
], { stdio: ["pipe", "inherit", "inherit", "pipe", "pipe"] });
const videoPipe = ffmpeg.stdio[3];
const audioPipe = ffmpeg.stdio[4];
(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            "--autoplay-policy=no-user-gesture-required",
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream"
        ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(PREVIEW_URL, { waitUntil: "networkidle0", timeout: 60000 }); // Change to your preview page
    // Inject audio recorder in the page
    await page.evaluate(() => {
        window.startAudioCapture = async () => {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
            recorder.ondataavailable = e => {
                if (e.data.size > 0) {
                    e.data.arrayBuffer().then(buf => {
                        window.sendAudio(Buffer.from(buf));
                    });
                }
            };
            recorder.start(100); // send audio every 100ms
        };
    });
    // Expose Node function to receive audio chunks
    await page.exposeFunction("sendAudio", chunk => {
        audioPipe.write(chunk);
    });
    // Start audio recording
    await page.evaluate(() => window.startAudioCapture());
    // Start Puppeteer screencast
    const client = await page.target().createCDPSession();
    await client.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        everyNthFrame: 1
    });
    client.on("Page.screencastFrame", async ({ data, sessionId }) => {
        videoPipe.write(Buffer.from(data, "base64"));
        await client.send("Page.screencastFrameAck", { sessionId });
    });
    console.log(`HLS stream is being written to: ${OUT_DIR}/stream.m3u8`);
})();
//# sourceMappingURL=main_not_working.js.map