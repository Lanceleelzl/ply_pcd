// Java 11+ example. Uses only the JDK HTTP client.
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class RegistrationClient {
    private static final Pattern JOB_ID = Pattern.compile("\\\"job_id\\\":\\\"([^\\\"]+)\\\"");

    public static void main(String[] args) throws Exception {
        String baseUrl = args.length > 0 ? args[0] : "http://localhost:8080";
        Path ply = Path.of(args.length > 1 ? args[1] : "source/ply/point_cloud.ply");
        Path pcd = Path.of(args.length > 2 ? args[2] : "source/pcd/GlobalMap.pcd");
        String boundary = "----Registration" + UUID.randomUUID();
        Path body = Files.createTempFile("registration-upload-", ".multipart");
        try (var output = Files.newOutputStream(body)) {
            writePart(output, boundary, "ply", ply, "application/octet-stream");
            writePart(output, boundary, "pcd", pcd, "application/octet-stream");
            output.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        }

        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/api/v1/registrations"))
                .timeout(Duration.ofMinutes(10))
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofFile(body)).build();
        String created = client.send(request, HttpResponse.BodyHandlers.ofString()).body();
        Matcher matcher = JOB_ID.matcher(created);
        if (!matcher.find()) throw new IllegalStateException("No job_id in response: " + created);
        String jobId = matcher.group(1);

        while (true) {
            String status = get(client, baseUrl + "/api/v1/registrations/" + jobId);
            if (status.contains("\"status\":\"succeeded\"")) {
                System.out.println(get(client, baseUrl + "/api/v1/registrations/" + jobId + "/result"));
                break;
            }
            if (status.contains("\"status\":\"failed\"")) throw new IllegalStateException(status);
            Thread.sleep(1000);
        }
        Files.deleteIfExists(body);
    }

    private static String get(HttpClient client, String url) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url)).GET().build();
        return client.send(request, HttpResponse.BodyHandlers.ofString()).body();
    }

    private static void writePart(java.io.OutputStream output, String boundary, String field,
                                  Path file, String contentType) throws Exception {
        String header = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + field
                + "\"; filename=\"" + file.getFileName() + "\"\r\nContent-Type: " + contentType + "\r\n\r\n";
        output.write(header.getBytes(StandardCharsets.UTF_8));
        Files.copy(file, output);
        output.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }
}
