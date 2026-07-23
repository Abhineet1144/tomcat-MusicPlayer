package servlets;

import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import javax.websocket.*;
import javax.websocket.server.*;
import org.json.*;

/**
 * DeviceWebSocket – real-time multi-device sync via WebSocket (JSR-356).
 *
 * Endpoint: /ws   (Tomcat auto-discovers @ServerEndpoint at startup)
 *
 * ── Protocol ──────────────────────────────────────────────────────────────────
 *
 *  Client → Server (JSON)
 *    { "type":"hello",     "deviceId":"...", "name":"..." }
 *    { "type":"ping",      "state":{…} }          ← keepalive + state update
 *    { "type":"cmd",       "to":"deviceId",        ← route to one peer
 *                          "cmd":"pause", "params":{} }
 *    { "type":"broadcast", "cmd":"seek",  "params":{"position":42.1} }  ← all peers
 *
 *  Server → Client (JSON)
 *    { "type":"devices", "list":[{id,name,lastSeen,state?},…] }
 *    { "type":"cmd",     "from":"deviceId", "cmd":"…", "params":{…} }
 *
 * Commands are delivered in-memory and discarded immediately – no file I/O,
 * no polling, no ACK needed (TCP guarantees delivery).
 * ─────────────────────────────────────────────────────────────────────────────
 */
@ServerEndpoint(
    value        = "/ws",
    configurator = DeviceWebSocket.Configurator.class
)
public class DeviceWebSocket {

    // ── Shared in-memory registry ─────────────────────────────────────────────
    // username → { deviceId → SessionInfo }
    private static final ConcurrentHashMap<String, ConcurrentHashMap<String, SessionInfo>>
        userDevices = new ConcurrentHashMap<>();

    /** Set by AuthServlet.init() so we can read sessions.json for authentication. */
    static volatile File dataDir;

    // ── Inner data class ──────────────────────────────────────────────────────
    static class SessionInfo {
        final Session  session;
        String         deviceId;
        String         deviceName;
        long           lastSeen;
        JSONObject     state;
        SessionInfo(Session s) { session = s; lastSeen = System.currentTimeMillis(); }
    }

    // ── Configurator: capture cookie header from upgrade request ──────────────
    public static class Configurator extends ServerEndpointConfig.Configurator {
        @Override
        public void modifyHandshake(ServerEndpointConfig cfg,
                                    HandshakeRequest    req,
                                    HandshakeResponse   res) {
            List<String> c = req.getHeaders().get("cookie");
            cfg.getUserProperties().put("cookie",
                (c != null && !c.isEmpty()) ? c.get(0) : "");
        }
    }

    // ── @OnOpen ───────────────────────────────────────────────────────────────
    @OnOpen
    public void onOpen(Session session, EndpointConfig cfg) {
        String cookie   = (String) cfg.getUserProperties().getOrDefault("cookie", "");
        String username = resolveUser(cookie);
        if (username == null) {
            try {
                session.close(new CloseReason(
                    CloseReason.CloseCodes.VIOLATED_POLICY, "Not authenticated"));
            } catch (IOException ignored) {}
            return;
        }
        SessionInfo info = new SessionInfo(session);
        session.getUserProperties().put("username", username);
        session.getUserProperties().put("info",     info);
    }

    // ── @OnMessage ────────────────────────────────────────────────────────────
    @OnMessage
    public void onMessage(String raw, Session session) {
        String      username = (String)      session.getUserProperties().get("username");
        SessionInfo info     = (SessionInfo) session.getUserProperties().get("info");
        if (username == null || info == null) return;

        try {
            JSONObject msg  = new JSONObject(raw);
            String     type = msg.optString("type", "");

            switch (type) {

                case "hello":
                    info.deviceId   = msg.optString("deviceId", session.getId());
                    info.deviceName = msg.optString("name", "Unknown");
                    info.lastSeen   = System.currentTimeMillis();
                    userDevices.computeIfAbsent(username, k -> new ConcurrentHashMap<>())
                               .put(info.deviceId, info);
                    pushDeviceList(username, null);
                    break;

                case "ping":
                    info.lastSeen = System.currentTimeMillis();
                    if (msg.has("state")) info.state = msg.getJSONObject("state");
                    pushDeviceList(username, null);   // refresh list for all peers
                    break;

                case "cmd": {
                    String targetId = msg.optString("to", "");
                    route(username, info.deviceId, targetId,
                          msg.optString("cmd", ""), msg.optJSONObject("params"));
                    break;
                }

                case "broadcast":
                    fanout(username, info.deviceId,
                           msg.optString("cmd", ""), msg.optJSONObject("params"));
                    break;

                default:
                    break;
            }

        } catch (Exception e) {
            send(session,
                 new JSONObject().put("type", "error").put("msg", e.getMessage()));
        }
    }

    // ── @OnClose ──────────────────────────────────────────────────────────────
    @OnClose
    public void onClose(Session session) {
        String      username = (String)      session.getUserProperties().get("username");
        SessionInfo info     = (SessionInfo) session.getUserProperties().get("info");
        if (username == null || info == null || info.deviceId == null) return;

        ConcurrentHashMap<String, SessionInfo> devices = userDevices.get(username);
        if (devices != null) {
            devices.remove(info.deviceId);
            if (devices.isEmpty()) userDevices.remove(username);
        }
        pushDeviceList(username, null);   // tell remaining peers this device left
    }

    @OnError
    public void onError(Session session, Throwable t) { /* swallow */ }

    // ── Routing ───────────────────────────────────────────────────────────────

    private void route(String username, String fromId, String toId,
                       String cmd, JSONObject params) {
        ConcurrentHashMap<String, SessionInfo> devices = userDevices.get(username);
        if (devices == null) return;
        SessionInfo target = devices.get(toId);
        if (target == null || !target.session.isOpen()) return;
        send(target.session, buildCmd(fromId, cmd, params));
    }

    private void fanout(String username, String fromId,
                        String cmd, JSONObject params) {
        ConcurrentHashMap<String, SessionInfo> devices = userDevices.get(username);
        if (devices == null) return;
        JSONObject envelope = buildCmd(fromId, cmd, params);
        devices.values().stream()
               .filter(si -> !si.deviceId.equals(fromId) && si.session.isOpen())
               .forEach(si -> send(si.session, envelope));
    }

    private void pushDeviceList(String username, Session onlyTo) {
        ConcurrentHashMap<String, SessionInfo> devices = userDevices.get(username);
        if (devices == null) return;

        JSONArray list = new JSONArray();
        devices.values().forEach(si -> {
            JSONObject entry = new JSONObject()
                .put("id",       si.deviceId   != null ? si.deviceId   : "?")
                .put("name",     si.deviceName != null ? si.deviceName : "Unknown")
                .put("lastSeen", si.lastSeen);
            if (si.state != null) entry.put("state", si.state);
            list.put(entry);
        });

        JSONObject msg = new JSONObject().put("type", "devices").put("list", list);
        if (onlyTo != null) {
            send(onlyTo, msg);
        } else {
            devices.values().stream()
                   .filter(si -> si.session.isOpen())
                   .forEach(si -> send(si.session, msg));
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private JSONObject buildCmd(String fromId, String cmd, JSONObject params) {
        return new JSONObject()
            .put("type",   "cmd")
            .put("from",   fromId)
            .put("cmd",    cmd)
            .put("params", params != null ? params : new JSONObject());
    }

    private void send(Session s, JSONObject msg) {
        try { s.getBasicRemote().sendText(msg.toString()); }
        catch (Exception ignored) {}
    }

    /** Parse the om_session cookie and look up the username in sessions.json. */
    private String resolveUser(String cookieHeader) {
        if (dataDir == null || cookieHeader == null || cookieHeader.isEmpty()) return null;
        String token = null;
        for (String part : cookieHeader.split(";")) {
            String[] kv = part.trim().split("=", 2);
            if (kv.length == 2 && "om_session".equals(kv[0].trim())) {
                token = kv[1].trim();
                break;
            }
        }
        if (token == null) return null;
        File sessFile = new File(dataDir, "sessions.json");
        if (!sessFile.exists()) return null;
        try {
            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new FileReader(sessFile))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
            }
            JSONObject sessions = new JSONObject(sb.toString());
            return sessions.has(token) ? sessions.getString(token) : null;
        } catch (Exception e) { return null; }
    }
}

