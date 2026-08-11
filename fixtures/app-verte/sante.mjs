// Contrat de santé de l'app témoin : index.html présent et marqueur intact.
import fs from "node:fs";
const html = fs.existsSync("index.html") ? fs.readFileSync("index.html", "utf8") : "";
if (!html.includes('data-sante="ok"')) { console.error("marqueur de santé absent"); process.exit(1); }
process.exit(0);
