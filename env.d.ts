/**
 * yu-agent — Bun-native type declarations.
 *
 * Bun provides Node.js compatibility modules at runtime. These
 * declarations cover only the module surface used across the project,
 * enabling full typecheck without the @types/node package.
 */

// ── fs (sync) ────────────────────────────────────────────

declare module 'fs' {
  export function existsSync(path: string | URL): boolean
  export function readFileSync(path: string | URL, options?: { encoding?: string | null; flag?: string } | string | null): string
  export function readFileSync(path: string | URL, options: { encoding?: string | null; flag?: string } | string | null & { encoding: 'utf-8' | 'utf8' }): string
  export function writeFileSync(path: string | URL, data: string | ArrayBufferView, options?: { encoding?: string | null; mode?: string | number; flag?: string } | string | null): void
  export function mkdirSync(path: string | URL, options?: { recursive?: boolean; mode?: string | number }): string | undefined
  export function readdirSync(path: string | URL, options?: { encoding?: string; withFileTypes?: false } | string): string[]
  export function readdirSync(path: string | URL, options: { withFileTypes: true }): Dirent[]
  export function unlinkSync(path: string | URL): void
  export function appendFileSync(path: string | URL, data: string | ArrayBufferView, options?: { encoding?: string } | string): void
  export function closeSync(fd: number): void
  export function openSync(path: string | URL, flags: string, mode?: number): number
  export function statSync(path: string | URL, options?: { bigint?: false }): Stats
  export function renameSync(oldPath: string, newPath: string): void
  export function writeSync(fd: number, buffer: string | ArrayBufferView, offset?: number, length?: number, position?: number): number
  export function watch(filename: string | URL, options?: { persistent?: boolean; recursive?: boolean; encoding?: string }): FSWatcher
  export function readlinkSync(path: string | URL): string
  export function readSync(fd: number, buffer: ArrayBufferView, offset?: number, length?: number, position?: number): number
  export function rmSync(path: string | URL, options?: { recursive?: boolean; force?: boolean }): void
  export function cpSync(src: string | URL, dest: string | URL, options?: { recursive?: boolean; force?: boolean }): void
  export function mkdtempSync(prefix: string, options?: { encoding?: string }): string
  export function realpathSync(path: string | URL, options?: { encoding?: string }): string
  export function linkSync(existingPath: string, newPath: string): void
  export function accessSync(path: string | URL, mode?: number): void
  export function chmodSync(path: string | URL, mode: string | number): void
  export function copyFileSync(src: string | URL, dest: string | URL, mode?: number): void
  export function fstatSync(fd: number): Stats
  export function lstatSync(path: string | URL, options?: { bigint?: false }): Stats
  export function truncateSync(path: string | URL, len?: number): void

  export class Dirent {
    name: string
    isFile(): boolean
    isDirectory(): boolean
    isBlockDevice(): boolean
    isCharacterDevice(): boolean
    isSymbolicLink(): boolean
    isFIFO(): boolean
    isSocket(): boolean
  }
  export class Stats {
    isFile(): boolean
    isDirectory(): boolean
    isBlockDevice(): boolean
    isCharacterDevice(): boolean
    isSymbolicLink(): boolean
    isFIFO(): boolean
    isSocket(): boolean
    dev: number; ino: number; mode: number; nlink: number
    uid: number; gid: number; rdev: number; size: number
    blksize: number; blocks: number
    atimeMs: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number
    atime: Date; mtime: Date; ctime: Date; birthtime: Date
  }
  export class FSWatcher {
    close(): void; ref(): void; unref(): void
  }
}

// ── fs/promises ──────────────────────────────────────────

declare module 'fs/promises' {
  export function mkdir(path: string | URL, options?: { recursive?: boolean; mode?: string | number }): Promise<string | undefined>
  export function readdir(path: string | URL, options?: { encoding?: string; withFileTypes?: false } | string): Promise<string[]>
  export function readFile(path: string | URL, options?: { encoding?: string | null; flag?: string } | string | null): Promise<string>
  export function writeFile(path: string | URL, data: string | ArrayBufferView, options?: { encoding?: string | null; mode?: string | number; flag?: string } | string | null): Promise<void>
  export function rename(oldPath: string, newPath: string): Promise<void>
  export function rm(path: string | URL, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  export function stat(path: string | URL, options?: { bigint?: false }): Promise<import('fs').Stats>
  export function unlink(path: string | URL): Promise<void>
  export function readlink(path: string | URL): Promise<string>
  export function symlink(target: string, path: string, type?: string): Promise<void>
  export function chmod(path: string | URL, mode: string | number): Promise<void>
  export function chown(path: string | URL, uid: number, gid: number): Promise<void>
  export function access(path: string | URL, mode?: number): Promise<void>
  export function copyFile(src: string | URL, dest: string | URL, mode?: number): Promise<void>
  export function mkdtemp(prefix: string, options?: { encoding?: string }): Promise<string>
  export function realpath(path: string | URL, options?: { encoding?: string }): Promise<string>
}

// ── path ─────────────────────────────────────────────────

declare module 'path' {
  export function resolve(...paths: string[]): string
  export function join(...paths: string[]): string
  export function dirname(path: string): string
  export function basename(path: string, ext?: string): string
  export function extname(path: string): string
  export function relative(from: string, to: string): string
  export function sep: string
  export function normalize(path: string): string
  export function parse(path: string): { root: string; dir: string; base: string; ext: string; name: string }
  export function isAbsolute(path: string): boolean
  export function format(pathObject: { root?: string; dir?: string; base?: string; ext?: string; name?: string }): string
  export const delimiter: string
}

// ── os ───────────────────────────────────────────────────

declare module 'os' {
  export function tmpdir(): string
  export function homedir(): string
  export function hostname(): string
  export function platform(): string
  export function type(): string
  export function release(): string
  export function endianness(): string
  export const EOL: string
  export function cpus(): { model: string; speed: number; times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]
  export function totalmem(): number
  export function freemem(): number
  export function loadavg(): number[]
  export function uptime(): number
  export function networkInterfaces(): Record<string, { address: string; netmask: string; family: string; mac: string; internal: boolean }[]>
  export function userInfo(options?: { encoding: string }): { username: string; uid: number; gid: number; shell: string | null; homedir: string }
  export function arch(): string
  export function version(): string
}

// ── crypto (Node.js compat — Bun provides at runtime) ────

declare module 'crypto' {
  export function randomBytes(size: number): Buffer
  export function createHash(algorithm: string): Hash
  export class Hash {
    update(data: string | Buffer, encoding?: string): this
    digest(encoding?: string): string
  }
  export function createHmac(algorithm: string, key: string | Buffer): Hmac
  export class Hmac {
    update(data: string | Buffer, encoding?: string): this
    digest(encoding?: string): string
  }
  export function randomUUID(options?: { disableEntropyCache?: boolean }): string
  export function randomInt(min: number, max: number): number
  export function createCipheriv(algorithm: string, key: Buffer, iv: Buffer | null): Cipher
  export function createDecipheriv(algorithm: string, key: Buffer, iv: Buffer | null): Decipher
  export class Cipher { update(data: string | Buffer, inputEncoding?: string, outputEncoding?: string): string; final(outputEncoding?: string): string }
  export class Decipher { update(data: string | Buffer, inputEncoding?: string, outputEncoding?: string): string; final(outputEncoding?: string): string }
  export function timingSafeEqual(a: Buffer, b: Buffer): boolean
  export function getCiphers(): string[]
  export function getHashes(): string[]
}

// ── util (Node.js compat) ────────────────────────────────

declare module 'util' {
  export function promisify<T>(fn: (...args: any[]) => void): (...args: any[]) => Promise<T>
  export function format(format: string, ...args: any[]): string
  export function inspect(obj: unknown, options?: { showHidden?: boolean; depth?: number; colors?: boolean }): string
  export function callbackify(fn: (...args: any[]) => Promise<any>): (...args: any[]) => void
  export function deprecate(fn: (...args: any[]) => any, msg: string): (...args: any[]) => any
  export function types: { isDate(v: unknown): boolean; isRegExp(v: unknown): boolean; isArrayBuffer(v: unknown): boolean; isMap(v: unknown): boolean; isSet(v: unknown): boolean; isPromise(v: unknown): boolean }
  export function isDeepStrictEqual(val1: unknown, val2: unknown): boolean
  export class TextEncoder { encode(input?: string): Uint8Array; encoding: string }
  export class TextDecoder { decode(input?: ArrayBufferView, options?: { stream?: boolean }): string; encoding: string }
}

// ── stream (Node.js compat) ─────────────────────────────

declare module 'stream' {
  export class PassThrough extends Transform {}
  export class Transform extends Duplex {}
  export class Duplex extends Readable {
    writable: boolean
    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void
  }
  export class Readable {
    readable: boolean
    pipe<T>(destination: T, options?: { end?: boolean }): T
    on(event: string, listener: (...args: any[]) => void): this
  }
  export class Writable {
    writable: boolean
    end(cb?: () => void): void
    write(chunk: any, cb?: (error?: Error | null) => void): boolean
  }
  export function finished(stream: NodeJS.ReadableStream | NodeJS.WritableStream, options?: { error?: boolean; readable?: boolean; writable?: boolean }, callback?: (err?: Error | null) => void): () => void
  export function pipeline(...streams: any[]): void
}

// ── assert ───────────────────────────────────────────────

declare module 'assert' {
  export function ok(value: unknown, message?: string): asserts value
  export function equal(actual: unknown, expected: unknown, message?: string): void
  export function notEqual(actual: unknown, expected: unknown, message?: string): void
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void
  export function notDeepEqual(actual: unknown, expected: unknown, message?: string): void
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void
  export function notStrictEqual(actual: unknown, expected: unknown, message?: string): void
  export function throws(fn: () => void, message?: string): void
  export function rejects(fn: () => Promise<unknown>, message?: string): void
  export function doesNotThrow(fn: () => void, message?: string): void
  export function fail(message?: string): never
}
