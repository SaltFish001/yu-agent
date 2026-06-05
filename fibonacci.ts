/**
 * 生成斐波那契数列 (Fibonacci sequence) 的前 n 项
 * F(0) = 0, F(1) = 1, F(n) = F(n-1) + F(n-2)
 *
 * @param n - 要生成的项数 (n >= 0)
 * @returns 包含前 n 个斐波那契数的数组
 */
function fibonacci(n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];

  const result: number[] = [0, 1];
  for (let i = 2; i < n; i++) {
    result.push(result[i - 1] + result[i - 2]);
  }
  return result;
}

// 示例
console.log(fibonacci(10)); // [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
