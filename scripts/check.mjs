import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

async function walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? walk(path.join(root, e.name)) : path.join(root, e.name)))).flat();
}
const files = await walk("extension");
for (const file of files.filter(f => f.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
}
const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
for (const file of ["panel/panel.html", ...Object.values(manifest.icons), ...manifest.background.scripts]) {
  if (!files.includes(`extension/${file}`)) throw new Error(`Missing manifest resource: ${file}`);
}
if (manifest.permissions.includes("<all_urls>") || manifest.host_permissions.includes("<all_urls>")) throw new Error("Broad website access must remain optional.");
console.log(`Checked ${files.filter(f => f.endsWith(".js")).length} JavaScript modules and manifest resources.`);
