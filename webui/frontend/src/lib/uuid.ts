/**
 * UUID v4 generator with crypto.randomUUID() fallback.
 * crypto.randomUUID() 只工作在安全上下文 (HTTPS/localhost)。
 * 从 LAN IP 访问时浏览器没有这个函数，用 Math.random 兜底。
 */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // fallback: Math.random-based UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}
