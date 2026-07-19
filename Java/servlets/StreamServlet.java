package servlets;

import java.io.*;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * Streams a FLAC song, optionally transcoding it to Opus via FFmpeg.
 * GET /stream?name=<songName>&quality=high|medium|low
 *   high   → original FLAC (lossless, largest)
 *   medium → Opus 128 kbps via libopus (~3–5 MB/song)
 *   low    → Opus 64 kbps  via libopus (~1.5–2.5 MB/song)
 */
public class StreamServlet extends HttpServlet {

    private File songsDir;

    @Override
    public void init() throws ServletException {
        songsDir = new File(getServletContext().getRealPath("/Songs"));
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse res)
            throws IOException {

        String rawName = req.getParameter("name");
        String quality = req.getParameter("quality"); // medium | low

        if (rawName == null || rawName.trim().isEmpty()) {
            res.sendError(400, "Missing name"); return;
        }

        File flac = findFlac(rawName.trim());
        if (flac == null) { res.sendError(404, "Song not found"); return; }

        // ── High quality: serve the raw FLAC with Range support ──────────
        if ("high".equals(quality) || quality == null) {
            serveFlac(flac, req, res);
            return;
        }

        // ── Medium / Low: transcode to Opus OGG via FFmpeg ───────────────
        String bitrate = "medium".equals(quality) ? "128k" : "64k";

        String[] cmd = {
            "ffmpeg", "-nostdin",
            "-i", flac.getAbsolutePath(),
            "-vn",                     // drop any cover-art stream
            "-c:a", "libopus",
            "-b:a", bitrate,
            "-f", "ogg",
            "-loglevel", "error",
            "pipe:1"
        };

        res.setContentType("audio/ogg; codecs=opus");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Audio-Quality", quality + " opus " + bitrate);

        Process proc = null;
        try {
            proc = new ProcessBuilder(cmd).start();
            drainAsync(proc.getErrorStream());      // prevent stderr blocking ffmpeg

            // Pipe ffmpeg stdout → HTTP response
            byte[] buf = new byte[16384];
            int n;
            InputStream src = proc.getInputStream();
            OutputStream dst = res.getOutputStream();
            while ((n = src.read(buf)) >= 0) {
                dst.write(buf, 0, n);
            }
            proc.waitFor();

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            if (!res.isCommitted()) res.sendError(500, e.getMessage());
        } finally {
            if (proc != null && proc.isAlive()) proc.destroyForcibly();
        }
    }

    // ── Serve raw FLAC with HTTP Range support ────────────────────────────
    private void serveFlac(File file, HttpServletRequest req, HttpServletResponse res)
            throws IOException {

        long fileLen    = file.length();
        String rangeHdr = req.getHeader("Range");

        res.setContentType("audio/flac");
        res.setHeader("Accept-Ranges", "bytes");

        if (rangeHdr != null && rangeHdr.startsWith("bytes=")) {
            String[] parts = rangeHdr.substring(6).split("-");
            long start = Long.parseLong(parts[0].trim());
            long end   = (parts.length > 1 && !parts[1].trim().isEmpty())
                         ? Long.parseLong(parts[1].trim()) : fileLen - 1;
            end = Math.min(end, fileLen - 1);

            res.setStatus(206);
            res.setHeader("Content-Range",  "bytes " + start + "-" + end + "/" + fileLen);
            res.setHeader("Content-Length", String.valueOf(end - start + 1));

            try (RandomAccessFile raf = new RandomAccessFile(file, "r");
                 OutputStream out = res.getOutputStream()) {
                raf.seek(start);
                byte[] buf = new byte[16384];
                long remaining = end - start + 1;
                int n;
                while (remaining > 0 &&
                       (n = raf.read(buf, 0, (int) Math.min(buf.length, remaining))) >= 0) {
                    out.write(buf, 0, n);
                    remaining -= n;
                }
            }
        } else {
            res.setHeader("Content-Length", String.valueOf(fileLen));
            try (InputStream in  = new FileInputStream(file);
                 OutputStream out = res.getOutputStream()) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
            }
        }
    }

    // ── Find the FLAC file for a (trimmed) song name ──────────────────────
    private File findFlac(String songName) throws IOException {
        // Direct path first
        File direct = new File(songsDir, songName + ".flac");
        if (direct.exists() && isInsideSongs(direct)) return direct;

        // Fuzzy: filenames can have leading/trailing spaces
        File[] files = songsDir.listFiles();
        if (files == null) return null;
        for (File f : files) {
            String fname = f.getName();
            int dot = fname.lastIndexOf('.');
            if (dot < 0 || !fname.substring(dot + 1).equalsIgnoreCase("flac")) continue;
            if (fname.substring(0, dot).trim().equals(songName)) return f;
        }
        return null;
    }

    private boolean isInsideSongs(File f) throws IOException {
        return f.getCanonicalPath()
                .startsWith(songsDir.getCanonicalPath() + File.separator);
    }

    // ── Drain a stream on a background thread ────────────────────────────
    private void drainAsync(InputStream stream) {
        new Thread(() -> {
            byte[] buf = new byte[4096];
            try { while (stream.read(buf) >= 0) {} }
            catch (IOException ignored) {}
        }).start();
    }
}

