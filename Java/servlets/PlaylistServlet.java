package servlets;

import java.io.*;
import javax.servlet.ServletException;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.json.JSONArray;
import org.json.JSONObject;

public class PlaylistServlet extends HttpServlet {

    private File dataDir;
    private File playlistsDir;

    @Override
    public void init() throws ServletException {
        dataDir = new File(getServletContext().getRealPath("/WEB-INF"), "data");
        playlistsDir = new File(dataDir, "playlists");
        playlistsDir.mkdirs();
    }

    /** GET /playlists  →  load playlists for current user */
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
        res.getWriter().println(loadPlaylists(username));
    }

    /** POST /playlists  →  action=save|create|delete|rename */
    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse res)
            throws IOException, ServletException {
        res.setContentType("application/json;charset=UTF-8");
        req.setCharacterEncoding("UTF-8");
        PrintWriter out = res.getWriter();

        String username = getUsername(req);
        if (username == null) {
            res.setStatus(401);
            out.println(new JSONObject().put("error", "Not authenticated"));
            return;
        }

        String action = req.getParameter("action");
        JSONObject result = new JSONObject();

        try {
            if ("save".equals(action)) {
                // Body = JSON array of playlists
                StringBuilder sb = new StringBuilder();
                try (BufferedReader br = req.getReader()) {
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line);
                }
                JSONArray playlists = new JSONArray(sb.toString());
                savePlaylists(username, playlists);
                result.put("success", true);

            } else if ("create".equals(action)) {
                String name = req.getParameter("name");
                if (name == null || name.trim().isEmpty()) {
                    result.put("success", false).put("error", "Invalid name");
                } else {
                    JSONArray pls = loadPlaylists(username);
                    JSONObject newPl = new JSONObject()
                            .put("name", name.trim())
                            .put("songs", new JSONArray());
                    pls.put(newPl);
                    savePlaylists(username, pls);
                    result.put("success", true).put("playlists", pls);
                }

            } else if ("delete".equals(action)) {
                int idx = Integer.parseInt(req.getParameter("index"));
                JSONArray pls = loadPlaylists(username);
                JSONArray newPls = new JSONArray();
                for (int i = 0; i < pls.length(); i++) {
                    if (i != idx) newPls.put(pls.get(i));
                }
                savePlaylists(username, newPls);
                result.put("success", true).put("playlists", newPls);

            } else if ("rename".equals(action)) {
                int idx = Integer.parseInt(req.getParameter("index"));
                String name = req.getParameter("name");
                JSONArray pls = loadPlaylists(username);
                if (idx >= 0 && idx < pls.length()) {
                    pls.getJSONObject(idx).put("name", name);
                    savePlaylists(username, pls);
                    result.put("success", true).put("playlists", pls);
                } else {
                    result.put("success", false).put("error", "Invalid index");
                }

            } else {
                result.put("success", false).put("error", "Unknown action");
            }
        } catch (Exception e) {
            result.put("success", false).put("error", e.getMessage());
        }

        out.println(result);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private JSONArray loadPlaylists(String username) {
        File file = new File(playlistsDir, sanitize(username) + ".json");
        if (!file.exists()) {
            // Return default "My Favorites" playlist
            JSONArray defaults = new JSONArray();
            defaults.put(new JSONObject()
                    .put("name", "My Favorites")
                    .put("songs", new JSONArray()));
            return defaults;
        }
        try {
            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new FileReader(file))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
            }
            return new JSONArray(sb.toString());
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private void savePlaylists(String username, JSONArray playlists) throws IOException {
        File file = new File(playlistsDir, sanitize(username) + ".json");
        try (FileWriter fw = new FileWriter(file)) {
            fw.write(playlists.toString(2));
        }
    }

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

