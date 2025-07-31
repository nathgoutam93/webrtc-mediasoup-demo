// @ts-nocheck
import { launch } from "puppeteer";
import { spawn } from "child_process";
import express from "express";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
process.on("unhandledRejection", (reason) => {
    console.error("🚨 Unhandled Promise Rejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("🚨 Uncaught Exception:", err);
});
// ─── CLI Arguments ──────────────────────────────────────────────
const roomId = process.argv[2];
const PORT = parseInt(process.argv[3], 10);
if (!roomId || isNaN(PORT)) {
    console.error("Usage: node stream.js <roomId> <port>");
    process.exit(1);
}
const PREVIEW_HOST = process.env.PREVIEW_HOST ||
    (process.env.RUNNING_IN_DOCKER ? "host.docker.internal" : "localhost");
const PREVIEW_PORT = process.env.PREVIEW_PORT || 8000;
const PREVIEW_URL = `http://${PREVIEW_HOST}:${PREVIEW_PORT}/preview?roomId=${roomId}`;
console.log(`🌐 Using preview URL: ${PREVIEW_URL}`);
const OUT_DIR = join(__dirname, "..", "public", "hls", roomId);
fs.mkdirSync(OUT_DIR, { recursive: true });
// ─── Serve the HLS Directory ───────────────────────────────────
const app = express();
app.use("/live", express.static(OUT_DIR));
app.listen(PORT, () => {
    console.log(`[${roomId}] HLS available at http://localhost:${PORT}/live/stream.m3u8`);
});
// ─── Spawn FFmpeg to grab the X11 display + PulseAudio → HLS ────
const ffmpeg = spawn("ffmpeg", [
    "-f", "x11grab",
    "-r", "25", // capture at 25 fps
    "-s", "1280x720", // match the browser viewport
    "-i", process.env.DISPLAY, // e.g. ":99"
    "-f", "pulse",
    "-i", "default", // in‑container PulseAudio source
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
], { stdio: ["ignore", "inherit", "inherit"] });
ffmpeg.on("error", err => console.error("[FFmpeg error]", err));
ffmpeg.on("close", code => console.log(`[FFmpeg] exited ${code}`));
// ─── Puppeteer: launch & kick‑off playback ──────────────────────
(async () => {
    const browser = await launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-gpu",
            "--autoplay-policy=no-user-gesture-required",
            "--window-size=1280,720"
        ],
        timeout: 120_000,
        dumpio: true,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    try {
        await page.goto(PREVIEW_URL, { waitUntil: "networkidle0", timeout: 60000 });
        console.log("[Puppeteer] Preview loaded");
        await page.mouse.click(1280 / 2, 720 / 2);
    }
    catch (err) {
        console.error("[Puppeteer] Failed to load preview:", err);
        await browser.close();
        process.exit(1);
    }
    // ─── Optional: monitor generated HLS files ────────────────────
    setInterval(() => {
        fs.readdir(OUT_DIR, (err, files) => {
            if (!err) {
                console.log(`[Monitor] HLS folder: ${files.join(", ")}`);
            }
        });
    }, 5000);
    // ─── Graceful shutdown ────────────────────────────────────────
    const shutdown = async () => {
        console.log("Shutting down…");
        try {
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
//# sourceMappingURL=main_x11.js.map