// Build-time SSR: render the React app to static HTML and inject it
// into the client index.html so the page is fully crawlable / OCR-friendly
// for search engines and indexers, while still hydrating on the client.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const clientDir = path.join(root, "dist/client");
const serverDir = path.join(root, "dist/server");

const template = fs.readFileSync(path.join(clientDir, "index.html"), "utf-8");
const { render, getDocRoutes } = await import(
  pathToFileURL(path.join(serverDir, "entry-server.js")).href
);

const routes = ["/", ...getDocRoutes()];

for (const route of routes) {
  const appHtml = render(route);
  const html = template.replace("<!--app-html-->", appHtml);
  const filePath =
    route === "/"
      ? path.join(clientDir, "index.html")
      : path.join(clientDir, route, "index.html");

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, html);
}

console.log(`✓ Prerendered ${routes.length} route(s) with SSR markup`);
