import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = resolve(import.meta.dirname, "..");
const toolsDirectory = join(root, ".tools");
const uvVersion = "0.12.3";
const uvExecutable = join(toolsDirectory, "uv", platform() === "win32" ? "uv.exe" : "uv");
const venvPython = platform() === "win32"
  ? join(root, ".venv", "Scripts", "python.exe")
  : join(root, ".venv", "bin", "python");
const runtimeDirectory = join(root, "runtime");
const activeWorker = join(runtimeDirectory, "local", "bin", platform() === "win32" ? "registration_worker.exe" : "registration_worker");
const localConfigPath = join(root, "config", "local.json");

async function readLocalConfig() {
  const config = JSON.parse(await readFile(localConfigPath, "utf8"));
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("config/local.json: port must be an integer between 1 and 65535");
  }
  if (!Number.isInteger(config.web_port) || config.web_port < 1 || config.web_port > 65535) {
    throw new Error("config/local.json: web_port must be an integer between 1 and 65535");
  }
  return config;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function managedEnvironment() {
  return {
    ...process.env,
    UV_CACHE_DIR: join(toolsDirectory, "uv-cache"),
    UV_PYTHON_INSTALL_DIR: join(toolsDirectory, "python"),
    UV_PYTHON_BIN_DIR: join(toolsDirectory, "python-bin"),
    UV_NO_MODIFY_PATH: "1",
  };
}

function uvAsset() {
  const key = `${platform()}-${arch()}`;
  const assets = {
    "win32-x64": "uv-x86_64-pc-windows-msvc.zip",
    "linux-x64": "uv-x86_64-unknown-linux-gnu.tar.gz",
    "darwin-x64": "uv-x86_64-apple-darwin.tar.gz",
    "darwin-arm64": "uv-aarch64-apple-darwin.tar.gz",
  };
  const asset = assets[key];
  if (!asset) throw new Error(`Unsupported local runtime platform: ${key}`);
  return asset;
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  if (!response.body) throw new Error(`Download returned an empty body: ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function findFile(directory, filename) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, filename);
      if (found) return found;
    } else if (entry.name === filename) {
      return path;
    }
  }
  return undefined;
}

async function ensureUv() {
  if (existsSync(uvExecutable)) return;
  const asset = uvAsset();
  const baseUrl = `https://github.com/astral-sh/uv/releases/download/${uvVersion}`;
  const temporary = join(toolsDirectory, "uv-download");
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  const archive = join(temporary, asset);
  console.log(`[setup] Downloading uv ${uvVersion} for ${platform()}-${arch()}...`);
  await download(`${baseUrl}/${asset}`, archive);
  await download(`${baseUrl}/${asset}.sha256`, `${archive}.sha256`);
  const checksumText = await readFile(`${archive}.sha256`, "utf8");
  const expected = checksumText.trim().split(/\s+/)[0].toLowerCase();
  const actual = await fileSha256(archive);
  if (actual !== expected) throw new Error(`uv SHA-256 mismatch: expected ${expected}, got ${actual}`);
  const extracted = join(temporary, "extracted");
  await mkdir(extracted, { recursive: true });
  run("tar", ["-xf", archive, "-C", extracted]);
  const binary = await findFile(extracted, platform() === "win32" ? "uv.exe" : "uv");
  if (!binary) throw new Error("uv executable was not found in the verified archive");
  await mkdir(dirname(uvExecutable), { recursive: true });
  await copyFile(binary, uvExecutable);
  if (platform() !== "win32") run("chmod", ["755", uvExecutable]);
  await rm(temporary, { recursive: true, force: true });
}

async function nativeFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await nativeFiles(path));
    else files.push(path);
  }
  return files;
}

async function nativeSourceHash() {
  const files = [join(root, "CMakeLists.txt"), join(root, "CMakePresets.json")];
  files.push(...await nativeFiles(join(root, "cpp")));
  files.push(...await nativeFiles(join(root, "libs", "cloudcompare_core")));
  files.sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function visualStudioAvailable() {
  if (process.env.REGISTRATION_NATIVE_MODE === "prebuilt") return false;
  if (platform() !== "win32") return false;
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const vswhere = join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!existsSync(vswhere)) return false;
  const result = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function prebuiltPaths() {
  if (platform() === "win32" && arch() === "x64") {
    const directory = join(root, "runtime-bin", "win32-x64");
    return { binary: join(directory, "registration_worker.exe"), manifest: join(directory, "manifest.json") };
  }
  throw new Error(`No prebuilt local worker for ${platform()}-${arch()}. Use Docker or install a native C++ toolchain.`);
}

async function writeNativeManifest(binary, manifest, sourceHash) {
  const bytes = await readFile(binary);
  const metadata = {
    schema_version: 1,
    platform: `${platform()}-${arch()}`,
    worker_sha256: createHash("sha256").update(bytes).digest("hex"),
    source_sha256: sourceHash,
    build: "Visual Studio 2022 Release, static MSVC runtime",
  };
  await writeFile(manifest, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function buildNative() {
  if (platform() !== "win32" || !visualStudioAvailable()) {
    throw new Error("Visual Studio 2022 C++ Build Tools were not found. Ordinary users can run pnpm run dev with the provided prebuilt worker.");
  }
  console.log("[native] Building registration_worker with Visual Studio 2022...");
  run("cmake", ["--preset", "windows-release"]);
  run("cmake", ["--build", "--preset", "windows-release"]);
  const built = join(root, "build", "windows-release", "Release", "registration_worker.exe");
  if (!existsSync(built)) throw new Error(`Native build did not produce ${built}`);
  const target = prebuiltPaths();
  await mkdir(dirname(target.binary), { recursive: true });
  await copyFile(built, target.binary);
  await writeNativeManifest(target.binary, target.manifest, await nativeSourceHash());
  console.log(`[native] Updated ${relative(root, target.binary)} and manifest.json`);
}

async function ensureWorker() {
  const target = prebuiltPaths();
  if (!existsSync(target.binary) || !existsSync(target.manifest)) {
    if (visualStudioAvailable()) await buildNative();
    else throw new Error("The prebuilt worker is missing and Visual Studio 2022 is not installed.");
  }
  let manifest = JSON.parse(await readFile(target.manifest, "utf8"));
  const sourceHash = await nativeSourceHash();
  if (manifest.source_sha256 !== sourceHash) {
    if (visualStudioAvailable()) {
      console.log("[native] C++ source changed; rebuilding and replacing the prebuilt worker...");
      await buildNative();
      manifest = JSON.parse(await readFile(target.manifest, "utf8"));
    } else {
      throw new Error("C++ source differs from the provided worker. Install Visual Studio 2022 Build Tools or restore the matching source before running.");
    }
  }
  const workerBytes = await readFile(target.binary);
  const workerHash = createHash("sha256").update(workerBytes).digest("hex");
  if (workerHash !== manifest.worker_sha256) throw new Error("Prebuilt worker SHA-256 verification failed");
  await mkdir(dirname(activeWorker), { recursive: true });
  await copyFile(target.binary, activeWorker);
  console.log(`[setup] Active worker: ${relative(root, activeWorker)}`);
}

async function setup() {
  const config = await readLocalConfig();
  await ensureUv();
  const environment = managedEnvironment();
  run(uvExecutable, ["python", "install", "3.12"], { env: environment });
  run(uvExecutable, ["sync", "--python", "3.12", "--no-dev"], { env: environment });
  await ensureWorker();
  console.log("[setup] Local runtime is ready.");
}

async function serve(development) {
  await setup();
  const { port, web_port: webPort } = await readLocalConfig();
  const environment = {
    ...process.env,
    REGISTRATION_RUNTIME_ROOT: runtimeDirectory,
    REGISTRATION_WORKER_PATH: activeWorker,
    REGISTRATION_MAX_CONCURRENT_JOBS: process.env.REGISTRATION_MAX_CONCURRENT_JOBS || "1",
    REGISTRATION_WORKER_TIMEOUT_SECONDS: process.env.REGISTRATION_WORKER_TIMEOUT_SECONDS || "1800",
    REGISTRATION_RESULT_RETENTION_HOURS: process.env.REGISTRATION_RESULT_RETENTION_HOURS || "168",
    REGISTRATION_CLEANUP_INTERVAL_SECONDS: process.env.REGISTRATION_CLEANUP_INTERVAL_SECONDS || "3600",
  };
  console.log(`[local] Starting API at http://localhost:${port}`);
  const api = spawn(venvPython, ["-m", "uvicorn", "app:app", "--app-dir", join(root, "service"), "--host", "127.0.0.1", "--port", String(port), "--log-config", join(root, "service", "logging.json")], {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  const children = [api];
  if (development) {
    console.log(`[local] Starting web development server at http://localhost:${webPort}`);
    children.push(spawn(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "--config", "web/vite.config.ts"], {
      cwd: root,
      env: environment,
      stdio: "inherit",
      shell: false,
    }));
  }
  const stopChildren = (signal) => children.forEach((child) => {
    if (!child.killed) child.kill(signal);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stopChildren(signal));
  const code = await new Promise((resolveExit) => {
    children.forEach((child) => child.on("exit", resolveExit));
  });
  stopChildren("SIGTERM");
  process.exitCode = code ?? 1;
}

async function test() {
  await setup();
  if (visualStudioAvailable()) {
    run("ctest", ["--preset", "windows-release", "--output-on-failure"]);
  } else {
    run(activeWorker, ["inspect-pcd", join(root, "source", "pcd", "GlobalMap.pcd")]);
  }
}

const command = process.argv[2];
if (command === "setup") await setup();
else if (command === "dev") await serve(true);
else if (command === "start") await serve(false);
else if (command === "build-native") { await buildNative(); await ensureWorker(); }
else if (command === "test") await test();
else throw new Error(`Unknown local runtime command: ${command}`);
