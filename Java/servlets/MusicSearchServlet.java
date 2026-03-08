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
    private File imagesFolder;

    @Override
    public void init() throws ServletException {
        songsFolder = new File(getServletContext().getRealPath("/"), "Songs");
        imagesFolder = new File(getServletContext().getRealPath("/"), "Img");
    }

    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws ServletException, IOException {
        PrintWriter out = response.getWriter();
        String name = request.getParameter("name").toLowerCase();
        JSONArray musics = new JSONArray();
        int entriesAdded = 0;

        for (File file : songsFolder.listFiles()) {
            String songName = file.getName().replace("." + getExtention(file), "");
            if (songName.toLowerCase().contains(name)) {
                entriesAdded++;
                JSONObject songData = new JSONObject();
                songData.put("name", songName);
                if (new File(imagesFolder, songName + ".png").exists()) {
                    songData.put("thumbnail", "./Img/" + songName + ".png");
                } else {
                    songData.put("thumbnail", "./Img/music.png");
                }
                musics.put(songData);
            }

            if (entriesAdded > 20) {
                break;
            }
        }

        out.println(musics);
    }

    private static String getExtention(File file) {
        String extension = "";
        String fileName = file.getName();
        int i = fileName.lastIndexOf('.');
        int p = fileName.lastIndexOf(File.separatorChar);

        if (i > p) {
            extension = fileName.substring(i+1);
        }
        return extension;
    }
}