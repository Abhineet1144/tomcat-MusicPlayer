package servlets;

import java.io.File;
import java.io.IOException;
import java.io.PrintWriter;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

import org.json.JSONArray;
import org.json.JSONObject;

public class MusicSearchServlet extends HttpServlet {
    private File songsFolder;

    @Override
    public void init() throws ServletException {
        songsFolder = new File(getServletContext().getRealPath("/"), "Songs");
    }

    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {
        response.setContentType("application/json;charset=UTF-8");
        PrintWriter out = response.getWriter();

        String nameParam = request.getParameter("name");
        String query = (nameParam == null ? "" : nameParam.trim().toLowerCase());

        JSONArray results = new JSONArray();
        File[] files = songsFolder.listFiles();
        if (files == null) { out.println(results); return; }

        int count = 0;
        for (File file : files) {
            if (file.isDirectory()) continue;
            String ext      = getExtension(file);
            String songName = file.getName().replace("." + ext, "").trim();
            if (songName.isEmpty()) continue;

            if (query.isEmpty() || songName.toLowerCase().contains(query)) {
                JSONObject obj = new JSONObject();
                obj.put("name", songName);
                results.put(obj);
                if (++count >= 30) break;
            }
        }

        out.println(results);
    }

    private static String getExtension(File file) {
        String name = file.getName();
        int i = name.lastIndexOf('.');
        return (i > 0) ? name.substring(i + 1) : "";
    }
}