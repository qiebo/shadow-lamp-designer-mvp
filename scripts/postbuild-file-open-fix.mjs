import fs from "node:fs";
import path from "node:path";

const distHtml = path.resolve("dist", "index.html");

if (!fs.existsSync(distHtml)) {
  process.exit(0);
}

let html = fs.readFileSync(distHtml, "utf8");

html = html.replace(
  /<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/,
  '<script defer src="$1"></script>',
);

const stylesheetMatch = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
if (stylesheetMatch) {
  const href = stylesheetMatch[1];
  const cssPath = path.resolve("dist", href.replace(/^\.\//, ""));
  if (fs.existsSync(cssPath)) {
    const css = fs.readFileSync(cssPath, "utf8").replace(/<\/style/gi, "<\\/style");
    html = html.replace(
      stylesheetMatch[0],
      `<style>\n${css}\n</style>`,
    );
  } else {
    html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/, "");
  }
}

fs.writeFileSync(distHtml, html, "utf8");
