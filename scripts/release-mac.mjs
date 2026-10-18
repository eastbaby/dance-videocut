import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const kind = process.argv[2] ?? "patch";
if (!new Set(["patch", "minor", "major"]).has(kind)) {
  throw new Error("Version kind must be patch, minor, or major.");
}

const packagePath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const [major, minor, patch] = packageJson.version.split(".").map(Number);
if (![major, minor, patch].every(Number.isInteger)) {
  throw new Error(`Unsupported version: ${packageJson.version}`);
}
const next = kind === "major" ? [major + 1, 0, 0] : kind === "minor" ? [major, minor + 1, 0] : [major, minor, patch + 1];
const version = next.join(".");

packageJson.version = version;
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

console.log(`Release version: ${packageJson.version} -> ${version}`);
const result = spawnSync("npm", ["run", "package:mac"], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
