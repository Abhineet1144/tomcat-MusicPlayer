package servlets;

import java.io.*;
import java.util.UUID;
import javax.servlet.ServletException;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.json.*;

/**
 * DeviceServlet – Multi-device management
 *
 * POST /devices  { action: "heartbeat", deviceId, name, state }
 *   → { success, commands: [...], devices: [...] }
 *   Registers the device / refreshes lastSeen, returns pending commands
 *   AND the list of all currently-active devices for this user.
 *
 * POST /devices  { action: "command", targetDeviceId, cmd, params }
 *   → { success }
 *   Enqueues a command for the target device.
 *
 * POST /devices  { action: "ack", deviceId, commandIds: [...] }
 *   → { success }
 *   Removes acknowledged commands from the queue.
 *
 * GET /devices
 *   → { devices: [...] }
 *   Returns active devices (seen within 30 s) for the current user.
 */
public class DeviceServlet extends HttpServlet {

    private static final long DEVICE_TIMEOUT_MS = 30_000L;

    private File dataDir;
    private File devicesDir;

    @Override
    public void init() throws ServletException {
        dataDir    = new File(getServletContext().getRealPath("/WEB-INF"), "data");
        devicesDir = new File(dataDir, "devices");
        devicesDir.mkdirs();
    }

    // ── GET /devices ─────────────────────────────────────────────────────────
    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse res)
            throws IOException {
        res.setContentType("application/json;charset=UTF-8");
        String username = getUsername(req);
        if (username == null) {
            res.setStatus(401);
            res.getWriter().println(new JSONObject().put("error", "Not authenticated"));
            return;
        }
        JSONArray active = getActiveDevices(loadData(username));
        res.getWriter().println(new JSONObject().put("devices", active));
    }

    // ── POST /devices ────────────────────────────────────────────────────────
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

        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = req.getReader()) {
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
        }

        JSONObject body   = sb.length() > 0 ? new JSONObject(sb.toString()) : new JSONObject();
        String     action = body.optString("action", "");
        JSONObject result = new JSONObject();

        try {
            switch (action) {
                case "heartbeat": result = doHeartbeat(username, body); break;
                case "command":   result = doCommand(username, body);   break;
                case "ack":       result = doAck(username, body);       break;
                default: result.put("success", false).put("error", "Unknown action: " + action);
            }
        } catch (Exception e) {
            result.put("success", false).put("error", e.getMessage());
        }

        res.getWriter().println(result);
    }

    // ── Action Handlers ──────────────────────────────────────────────────────

    /**
     * Heartbeat: update device entry, return pending commands + active devices.
     */
    private synchronized JSONObject doHeartbeat(String username, JSONObject body) throws Exception {
        String deviceId = body.optString("deviceId", "");
        if (deviceId.isEmpty()) throw new IllegalArgumentException("Missing deviceId");

        JSONObject data     = loadData(username);
        JSONObject devices  = ensureObj(data, "devices");
        JSONObject commands = ensureObj(data, "commands");

        // Upsert device
        JSONObject device = devices.optJSONObject(deviceId);
        if (device == null) device = new JSONObject();
        device.put("id",       deviceId);
        device.put("name",     body.optString("name", "Unknown"));
        device.put("lastSeen", System.currentTimeMillis());
        if (body.has("state")) device.put("state", body.get("state"));
        devices.put(deviceId, device);

        // Collect & clear pending commands for this device
        JSONArray pending = commands.optJSONArray(deviceId);
        if (pending == null) pending = new JSONArray();

        saveData(username, data);

        return new JSONObject()
                .put("success",  true)
                .put("commands", pending)
                .put("devices",  getActiveDevices(data));
    }

    /**
     * Enqueue a command for the target device.
     */
    private synchronized JSONObject doCommand(String username, JSONObject body) throws Exception {
        String targetId = body.optString("targetDeviceId", "");
        String cmd      = body.optString("cmd", "");
        if (targetId.isEmpty() || cmd.isEmpty())
            throw new IllegalArgumentException("Missing targetDeviceId or cmd");

        JSONObject data     = loadData(username);
        JSONObject commands = ensureObj(data, "commands");

        JSONArray queue = commands.optJSONArray(targetId);
        if (queue == null) queue = new JSONArray();

        queue.put(new JSONObject()
                .put("id",     UUID.randomUUID().toString())
                .put("cmd",    cmd)
                .put("params", body.has("params") ? body.get("params") : new JSONObject())
                .put("ts",     System.currentTimeMillis()));

        commands.put(targetId, queue);
        saveData(username, data);

        return new JSONObject().put("success", true);
    }

    /**
     * Remove acknowledged commands from the pending queue.
     */
    private synchronized JSONObject doAck(String username, JSONObject body) throws Exception {
        String     deviceId = body.optString("deviceId", "");
        JSONArray  ackIds   = body.optJSONArray("commandIds");
        if (deviceId.isEmpty() || ackIds == null)
            throw new IllegalArgumentException("Missing deviceId or commandIds");

        JSONObject data     = loadData(username);
        JSONObject commands = ensureObj(data, "commands");
        JSONArray  pending  = commands.optJSONArray(deviceId);
        if (pending == null) return new JSONObject().put("success", true);

        java.util.Set<String> acked = new java.util.HashSet<>();
        for (int i = 0; i < ackIds.length(); i++) acked.add(ackIds.getString(i));

        JSONArray remaining = new JSONArray();
        for (int i = 0; i < pending.length(); i++) {
            JSONObject c = pending.getJSONObject(i);
            if (!acked.contains(c.optString("id"))) remaining.put(c);
        }
        commands.put(deviceId, remaining);

        saveData(username, data);
        return new JSONObject().put("success", true);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private JSONArray getActiveDevices(JSONObject data) {
        JSONObject devices = data.optJSONObject("devices");
        if (devices == null) return new JSONArray();
        long now = System.currentTimeMillis();
        JSONArray active = new JSONArray();
        for (String key : devices.keySet()) {
            JSONObject d = devices.getJSONObject(key);
            if (now - d.optLong("lastSeen", 0) < DEVICE_TIMEOUT_MS) active.put(d);
        }
        return active;
    }

    private JSONObject ensureObj(JSONObject parent, String key) throws JSONException {
        JSONObject obj = parent.optJSONObject(key);
        if (obj == null) { obj = new JSONObject(); parent.put(key, obj); }
        return obj;
    }

    private JSONObject loadData(String username) {
        File file = new File(devicesDir, sanitize(username) + ".json");
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

    private void saveData(String username, JSONObject data) throws IOException {
        File file = new File(devicesDir, sanitize(username) + ".json");
        try (FileWriter fw = new FileWriter(file)) {
            fw.write(data.toString(2));
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

    private String sanitize(String s) {
        return s.replaceAll("[^a-zA-Z0-9_\\-]", "_");
    }
}

