// @ts-nocheck
import puppeteer from "puppeteer";
import { spawn } from "child_process";
import express from "express";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Buffer } from "buffer";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ─── CLI Arguments ──────────────────────────────────────────────
const roomId = process.argv[2];
const PORT = parseInt(process.argv[3], 10);
if (!roomId || isNaN(PORT)) {
    console.error("Usage: node stream.js <roomId> <port>");
    process.exit(1);
}
const PREVIEW_URL = `http://localhost:8000/preview?roomId=${roomId}`;
const OUT_DIR = join(__dirname, "..", "..", "public", "hls", roomId);
fs.mkdirSync(OUT_DIR, { recursive: true });
// ─── Serve the HLS Directory ───────────────────────────────────
const app = express();
app.use("/live", express.static(OUT_DIR));
app.listen(PORT, () => {
    console.log(`[${roomId}] HLS available at http://localhost:${PORT}/live/stream.m3u8`);
});
// ─── Puppeteer + FFmpeg via MediaRecorder ───────────────────────
(async () => {
    // 1) Launch headless Chrome with autoplay allowed
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-gpu",
            "--autoplay-policy=no-user-gesture-required"
        ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on("console", msg => console.log(`[Page ${msg.type()}] ${msg.text()}`));
    // 2) Navigate to your preview & wait for the video element
    try {
        await page.goto(PREVIEW_URL, { waitUntil: "networkidle0", timeout: 60000 });
        console.log("[Puppeteer] Preview loaded");
        await page.waitForSelector("video", { timeout: 60000 });
        await page.evaluate(() => {
            document.dispatchEvent(new MouseEvent("click", {
                view: window,
                bubbles: true,
                cancelable: true
            }));
        });
    }
    catch (err) {
        console.error("[Puppeteer] Failed to load preview:", err);
        await browser.close();
        process.exit(1);
    }
    // 3) Spawn FFmpeg to read WebM from stdin (fd 3) → HLS
    const ffmpegArgs = [
        "-loglevel", "info", // verbose logging
        "-report", // dump ffmpeg-*.log
        "-f", "webm", // input format
        "-i", "pipe:3", // WebM chunks from MediaRecorder
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-f", "hls",
        "-hls_time", "2",
        "-hls_list_size", "5",
        "-hls_flags", "delete_segments+append_list",
        "-hls_segment_filename", join(OUT_DIR, "segment_%03d.ts"),
        join(OUT_DIR, "stream.m3u8")
    ];
    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
        stdio: ["ignore", "inherit", "inherit", "pipe"] // fd3=pipe → mediaStdin
    });
    console.log(`[FFmpeg] spawned at ${new Date().toISOString()}`);
    ffmpeg.on("error", err => console.error("[FFmpeg spawn error]", err));
    ffmpeg.on("close", code => console.log(`[FFmpeg] exited with code ${code}`));
    ffmpeg.stderr?.on("data", data => console.error("[FFmpeg]", data.toString()));
    const mediaStdin = ffmpeg.stdio[3];
    let chunkCount = 0;
    // 4) Expose a function for the page to send us base64 WebM chunks
    await page.exposeFunction("sendMediaChunk", (b64) => {
        const buf = Buffer.from(b64, "base64");
        mediaStdin.write(buf);
        if (++chunkCount % 10 === 0) {
            console.log(`[Debug] media chunks sent: ${chunkCount}`);
        }
    });
    // 5) In-page: start MediaRecorder on the <video> element
    await page.evaluate(() => {
        const video = document.querySelector("video");
        if (!video) {
            console.error("No <video> element found.");
            return;
        }
        // Ensure it’s playing
        video.play().catch(err => console.error("video.play() failed:", err));
        // Grab its combined video+audio stream
        const stream = video.captureStream();
        if (!stream) {
            console.error("captureStream() returned no stream");
            return;
        }
        // Record every 1 s, send to Node
        const recorder = new MediaRecorder(stream, {
            mimeType: "video/webm; codecs=vp8,opus"
        });
        recorder.ondataavailable = async (e) => {
            const ab = await e.data.arrayBuffer();
            const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
            // @ts-ignore
            window.sendMediaChunk(b64);
        };
        recorder.start(1000);
        console.log("MediaRecorder started on <video> stream");
    });
    // 6) Watch your HLS folder for output
    setInterval(() => {
        fs.readdir(OUT_DIR, (err, files) => {
            if (!err) {
                console.log(`[Monitor] HLS folder contains: ${files.join(", ")}`);
            }
        });
    }, 5000);
    // 7) Graceful shutdown
    const shutdown = async () => {
        console.log("Shutting down…");
        try {
            mediaStdin.end();
            ffmpeg.kill("SIGINT");
            await browser.close();
            process.exit(0);
        }
        catch (e) {
            console.error("Shutdown error:", e);
            process.exit(1);
        }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
})();
//# sourceMappingURL=stream-worker.js.map