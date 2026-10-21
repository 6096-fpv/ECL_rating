import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "qa", "fixtures");

const pages = [
  "index.html", "top.html", "forum.html", "teacher.html",
  "conta.html", "auth.html", "admin.html"
];
const assets = ["app.js", "style.css", "favicon.svg"];

let n = 0;

for (const theme of ["dark", "light"]) {
  const dir = path.join(out, theme);
  fs.mkdirSync(dir, { recursive: true });

  for (const f of [...pages, ...assets]) {
    let c = fs.readFileSync(path.join(root, f), "utf8");

    if (f.endsWith(".html")) {
      if (theme === "light") {
        if (!/<html[^>]*data-theme/.test(c)) {
          c = c.replace('<html lang="pt">', '<html lang="pt" data-theme="light">');
        }
      } else {
        c = c.replace('<html lang="pt" data-theme="light">', '<html lang="pt">');
      }

      if (theme === "light" && !/data-theme="light"/.test(c)) {
        console.error("THEME-INJECT-FAILED " + f);
        process.exit(1);
      }
    }

    fs.writeFileSync(path.join(dir, f), c);
    n++;
  }
}

console.log("fixtures ready: " + n + " files -> qa/fixtures/{dark,light}");
