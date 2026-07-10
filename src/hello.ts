/**
 * 向指定名称的人打招呼
 * @param name - 要打招呼的人名
 * @returns 问候语字符串
 */
export function greet(name: string): string {
  if (!name || name.trim().length === 0) {
    return 'Hello, World!';
  }
  return `Hello, ${name}!`;
}

/**
 * 生成带时间戳的问候语
 * @param name - 要打招呼的人名
 * @returns 带时间戳的问候语字符串
 */
export function greetWithTime(name: string): string {
  const time = new Date().toLocaleTimeString();
  return `Hello, ${name}! Current time is ${time}.`;
}

/**
 * 生成格式化的问候语（支持多种格式）
 * @param name - 要打招呼的人名
 * @param format - 问候格式（'formal' | 'casual' | 'enthusiastic'）
 * @returns 格式化后的问候语
 */
export function greetFormatted(name: string, format: 'formal' | 'casual' | 'enthusiastic' = 'casual'): string {
  const greetings: Record<string, string> = {
    formal: 'Good day',
    casual: 'Hello',
    enthusiastic: 'Hey there',
  };
  const greeting = greetings[format] || greetings.casual;
  return `${greeting}, ${name}!`;
}
