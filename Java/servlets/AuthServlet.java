package servlets;

import java.io.*;
import java.security.MessageDigest;
import java.util.UUID;
import javax.servlet.ServletException;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.json.JSONObject;

public class AuthServlet extends HttpServlet {

    private File dataDir;
    private File usersFile;
    private File sessionsFile;

    @Override
    public void init() throws ServletException {
        dataDir = new File(getServletContext().getRealPath("/WEB-INF"), "data");
        dataDir.mkdirs();
        usersFile    = new File(dataDir, "users.json");
        sessionsFile = new File(dataDir, "sessions.json");
        try {
            if (!usersFile.exists())    writeFile(usersFile,    "{}");
            if (!sessionsFile.exists()) writeFile(sessionsFile, "{}");
        } catch (IOException e) {
            throw new ServletException(e);
        }
    }

    /** GET /auth  →  check current session */
    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        res.setContentType("application/json;charset=UTF-8");
        String username = getSessionUsername(req);
        JSONObject result = new JSONObject();
        if (username != null) {
            result.put("loggedIn", true).put("username", username);
        } else {
            result.put("loggedIn", false);
        }
        res.getWriter().println(result);
    }

    /** POST /auth  →  action=login|register|logout */
    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        res.setContentType("application/json;charset=UTF-8");
        req.setCharacterEncoding("UTF-8");
        PrintWriter out = res.getWriter();
        String action = req.getParameter("action");
        JSONObject result = new JSONObject();

        if ("logout".equals(action)) {
            Cookie[] cookies = req.getCookies();
            if (cookies != null) {
                JSONObject sessions = readJSONObject(sessionsFile);
                for (Cookie c : cookies) {
                    if ("om_session".equals(c.getName())) {
                        sessions.remove(c.getValue());
                        Cookie del = new Cookie("om_session", "");
                        del.setMaxAge(0); del.setPath("/");
                        res.addCookie(del);
                    }
                }
                writeFile(sessionsFile, sessions.toString());
            }
            result.put("success", true);

        } else if ("login".equals(action)) {
            String u = req.getParameter("username");
            String p = req.getParameter("password");
            JSONObject users = readJSONObject(usersFile);
            if (u == null || p == null) {
                result.put("success", false).put("error", "Missing credentials");
            } else if (!users.has(u)) {
                result.put("success", false).put("error", "User not found");
            } else if (!users.getString(u).equals(hash(p))) {
                result.put("success", false).put("error", "Incorrect password");
            } else {
                String token = createSession(u);
                addSessionCookie(res, token);
                result.put("success", true).put("username", u);
            }

        } else if ("register".equals(action)) {
            String u = req.getParameter("username");
            String p = req.getParameter("password");
            JSONObject users = readJSONObject(usersFile);
            if (u == null || u.trim().length() < 3) {
                result.put("success", false).put("error", "Username must be at least 3 characters");
            } else if (p == null || p.length() < 4) {
                result.put("success", false).put("error", "Password must be at least 4 characters");
            } else if (users.has(u)) {
                result.put("success", false).put("error", "Username already taken");
            } else {
                users.put(u, hash(p));
                writeFile(usersFile, users.toString());
                String token = createSession(u);
                addSessionCookie(res, token);
                result.put("success", true).put("username", u);
            }
        } else {
            result.put("success", false).put("error", "Unknown action");
        }

        out.println(result);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    public String getSessionUsername(HttpServletRequest req) {
        Cookie[] cookies = req.getCookies();
        if (cookies == null) return null;
        JSONObject sessions = readJSONObject(sessionsFile);
        for (Cookie c : cookies) {
            if ("om_session".equals(c.getName()) && sessions.has(c.getValue())) {
                return sessions.getString(c.getValue());
            }
        }
        return null;
    }

    private void addSessionCookie(HttpServletResponse res, String token) {
        Cookie c = new Cookie("om_session", token);
        c.setMaxAge(30 * 24 * 3600);
        c.setPath("/");
        res.addCookie(c);
    }

    private String createSession(String username) throws IOException {
        String token = UUID.randomUUID().toString();
        JSONObject sessions = readJSONObject(sessionsFile);
        sessions.put(token, username);
        writeFile(sessionsFile, sessions.toString());
        return token;
    }

    private String hash(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] bytes = md.digest(input.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte b : bytes) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return input;
        }
    }

    JSONObject readJSONObject(File file) {
        try {
            if (!file.exists()) return new JSONObject();
            return new JSONObject(readFile(file));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    String readFile(File file) throws IOException {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new FileReader(file))) {
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append("\n");
        }
        return sb.toString();
    }

    void writeFile(File file, String content) throws IOException {
        try (FileWriter fw = new FileWriter(file)) {
            fw.write(content);
        }
    }
}

