#!/usr/bin/env python3

def calculate_fibonacci(n):
    """计算斐波那契数列第 n 项"""
    if n <= 0:
        return 0
    elif n == 1:
        return 1
    else:
        a, b = 0, 1
        for _ in range(2, n + 1):
            a, b = b, a + b
        return b

if __name__ == '__main__':
    import sys
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    print(f"斐波那契数列第 {n} 项是: {calculate_fibonacci(n)}")
