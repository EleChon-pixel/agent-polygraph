// Atomic, permission-preserving edits for user-owned hook and shell settings.
// Original content is backed up outside the repository before every change.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const statKey = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
const backupRoot = () => path.join(process.env.AGENT_POLYGRAPH_HOME || path.join(os.homedir(), ".agent-polygraph"), "backups");

function checkDirectory(dir, create = false) {
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Unsafe settings directory: " + dir);
  // A directory owned by someone else could redirect the settings file.
  if (process.platform !== "win32" && st.uid !== process.getuid()) throw new Error("Settings directory is not owned by this user: " + dir);
}

export function readSettings(file) {
  let fd;
  try {
    const st = fs.lstatSync(file, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n) throw new Error("Unsafe settings file: " + file);
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== st.dev || opened.ino !== st.ino)
      throw new Error("Settings file changed while opening: " + file);
    if (process.platform !== "win32" && opened.uid !== BigInt(process.getuid()))
      throw new Error("Settings file belongs to another user: " + file);
    const data = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (statKey(after) !== statKey(opened)) throw new Error("Settings file changed during read: " + file);
    return { text: data.toString("utf8"), stat: after, mode: Number(opened.mode & 0o777n) };
  } catch (e) {
    if (e.code === "ENOENT") return { text: null, stat: null, mode: 0o600 };
    throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function backupOriginal(file, previous) {
  if (previous.text === null) return null;
  const dir = backupRoot();
  checkDirectory(dir, true);
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  const id = crypto.createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 16);
  const target = path.join(dir, id + "-" + Date.now() + "-" + crypto.randomBytes(5).toString("hex") + ".bak");
  fs.writeFileSync(target, previous.text, { flag: "wx", mode: 0o600 });
  return target;
}

// Never truncate the user's existing config. Write a sibling temp file, fsync,
// and atomically rename it only after confirming the source is still unchanged.
export function writeSettings(file, text) {
  const parent = path.dirname(file);
  checkDirectory(parent, true);
  const previous = readSettings(file);
  if (previous.text === text) return { changed: false, backup: null };
  const backup = backupOriginal(file, previous);
  const tmp = path.join(parent, "." + path.basename(file) + ".apg-" + crypto.randomBytes(10).toString("hex"));
  let created = false;
  try {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, previous.mode);
    created = true;
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const current = readSettings(file);
    if ((previous.stat === null) !== (current.stat === null) ||
        (previous.stat && statKey(previous.stat) !== statKey(current.stat)))
      throw new Error("Settings changed concurrently; original not overwritten: " + file);
    fs.renameSync(tmp, file);
    created = false;
    return { changed: true, backup };
  } finally {
    if (created) fs.rmSync(tmp, { force: true });
  }
}

export function backupDirectory() { return backupRoot(); }
