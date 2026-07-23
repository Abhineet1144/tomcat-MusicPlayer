package servlets;

import java.io.*;
import javax.servlet.ServletException;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.json.JSONObject;

/**
 * StateServlet – persists per-user player state (queue, progress, volume, EQ …)
 *
 * GET  /state  → returns the saved state JSON (or {})
 * POST /state  → replaces the saved state with the JSON body
 */
public class StateServlet extends HttpServlet {

    private File dataDir;
    private File stateDir;

    @Override
    public void init() throws ServletException {
        dataDir  = new File(getServletContext().getRealPath("/WEB-INF"), "data");
        stateDir = new File(dataDir, "state");
        stateDir.mkdirs();
    }

    // ── GET /state ──────────────────────────────────────────────────────────
    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse res)
            throws IOException, ServletException {
        res.setContentType("application/json;charset=UTF-8");
        String username = getUsername(req);
        if (username == null) {
            res.setStatus(401);
            res.getWriter().println(new JSONObject().put("error", "Not authenticated"));
            return;
        }
        res.getWriter().println(loadState(username));
    }

    // ── POST /state ─────────────────────────────────────────────────────────
    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse res)
            throws IOException, ServletException {
        res.setContentType("application/json;charset=UTF-8");
        req.setCharacterEncoding("UTF-8");

        String username = getUsername(req);
        if (username == null) {
            res.setStatus(401);
            res.getWriter().println(new JSONObject().put("error", "Not authenticated"));
            return;
        }

        // Read JSON body
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = req.getReader()) {
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
        }

        JSONObject result = new JSONObject();
        try {
            JSONObject state = new JSONObject(sb.toString());
            saveState(username, state);
            result.put("success", true);
        } catch (Exception e) {
            result.put("success", false).put("error", e.getMessage());
        }
        res.getWriter().println(result);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private JSONObject loadState(String username) {
        File file = new File(stateDir, sanitize(username) + ".json");
        if (!file.exists()) return new JSONObject();
        try {
            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new FileReader(file))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
            }
            return new JSONObject(sb.toString());
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private void saveState(String username, JSONObject state) throws IOException {
        File file = new File(stateDir, sanitize(username) + ".json");
        try (FileWriter fw = new FileWriter(file)) {
            fw.write(state.toString(2));
        }
    }

    /** Resolve cookie → username via sessions.json (same logic as PlaylistServlet). */
    private String getUsername(HttpServletRequest req) {
        Cookie[] cookies = req.getCookies();
        if (cookies == null) return null;
        File sessionsFile = new File(dataDir, "sessions.json");
        if (!sessionsFile.exists()) return null;
        try {
            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new FileReader(sessionsFile))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
            }
            JSONObject sessions = new JSONObject(sb.toString());
            for (Cookie c : cookies) {
                if ("om_session".equals(c.getName()) && sessions.has(c.getValue())) {
                    return sessions.getString(c.getValue());
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    private String sanitize(String username) {
        return username.replaceAll("[^a-zA-Z0-9_\\-]", "_");
    }
}

