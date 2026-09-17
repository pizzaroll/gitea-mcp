import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { check, object, strictJSON } from './core.js';

export const newID = () => randomBytes(32).toString('hex');
export interface RecordBase { id: string; expires_at: number; kind: string }

// One process/replica per private LOCAL directory. The lock deliberately survives a crash:
// an operator must confirm the old process is stopped before removing .writer-lock.
export class ChangeStore {
  private readonly dir: string;
  private closed = false;
  constructor(directory: string, private readonly maxBytes = 64_000_000,
    private readonly maxRecords = 128, private readonly now = Date.now) {
    this.dir = path.resolve(directory);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.dir);
    check(fs.realpathSync(this.dir) === this.dir && stat.isDirectory() && (stat.mode & 0o077) === 0 &&
      (!process.getuid || stat.uid === process.getuid()), 'UNSAFE_STATE_DIRECTORY', 'State directory must be private, owned and symlink-free');
    try { fs.mkdirSync(path.join(this.dir, '.writer-lock'), { mode: 0o700 }); }
    catch { throw new Error('State directory locked; never share it between processes. See FILE-TRANSFER.md for crash recovery.'); }
  }
  private filename(id: string) {
    check(!this.closed, 'STORE_CLOSED', 'State store is closed');
    check(/^[a-f0-9]{64}$/.test(id), 'NOT_FOUND', 'State record not found');
    return path.join(this.dir, `${id}.json`);
  }
  get<T extends RecordBase>(id: string): T {
    const name = this.filename(id);
    check(fs.existsSync(name), 'NOT_FOUND', 'State record not found');
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      check(st.isFile() && st.nlink === 1 && (st.mode & 0o077) === 0 && st.size <= 12_000_000,
        'STATE_CORRUPT', 'Unsafe state record');
      const v = object(strictJSON(fs.readFileSync(fd)));
      check(v.id === id && typeof v.kind === 'string' && typeof v.expires_at === 'number' && Number.isFinite(v.expires_at),
        'STATE_CORRUPT', 'Invalid state record');
      check(v.expires_at > this.now(), 'EXPIRED', 'State record expired; export a new snapshot');
      return v as unknown as T;
    } finally { fs.closeSync(fd); }
  }
  put<T extends RecordBase>(record: T): void {
    const destination = this.filename(record.id);
    const bytes = Buffer.from(JSON.stringify(record));
    check(bytes.length <= 12_000_000, 'TOO_LARGE', 'State record exceeds limit');
    this.gc(); let used = bytes.length, count = 1;
    for (const name of fs.readdirSync(this.dir)) {
      if (name === '.writer-lock' || name === `${record.id}.json`) continue;
      const info = fs.lstatSync(path.join(this.dir, name));
      check(info.isFile() && !info.isSymbolicLink(), 'STATE_CORRUPT', 'Unexpected state directory entry');
      used += info.size; count++;
    }
    check(used <= this.maxBytes && count <= this.maxRecords, 'STATE_QUOTA_EXCEEDED', 'Staging quota reached; expired records are cleaned automatically');
    const temporary = path.join(this.dir, `.${newID()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try {
      fs.renameSync(temporary, destination);
      const dir = fs.openSync(this.dir, fs.constants.O_RDONLY);
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  gc(): void {
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try { this.get(name.slice(0, -5)); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EXPIRED') fs.unlinkSync(path.join(this.dir, name));
        else throw error;
      }
    }
  }
  close(): void {
    if (!this.closed) { fs.rmdirSync(path.join(this.dir, '.writer-lock')); this.closed = true; }
  }
}
