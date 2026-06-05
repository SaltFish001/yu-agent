/**
 * 数组去重，返回去重后的新数组。
 * 原数组不会被修改。
 *
 * @param arr - 输入的数字数组
 * @returns 去重后的数字数组，元素顺序按首次出现顺序保留
 */
function unique(arr: number[]): number[] {
  return [...new Set(arr)];
}

// 使用示例
// const result = unique([1, 2, 2, 3, 1, 4]); // => [1, 2, 3, 4]
