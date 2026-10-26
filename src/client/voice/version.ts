/**
 * 版本号比较（更新闸门用）。
 *
 * 只处理 `x.y.z` 这种最简形式——我们自己的版本号一直是这个形状，
 * 不需要 semver 的预发布/构建元数据（真出现 `1.9.4-beta` 会按 1.9.4 解析，
 * 对闸门来说这是保守方向：宁可判成"不低于"，也不要把测试版用户锁在外面）。
 *
 * 为什么不用字符串比较：`"1.9.10" < "1.9.9"` 在字典序下为真，但数值上
 * 1.9.10 更新。这里必须按段转数字后逐段比。
 */
export function versionLt(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    // 段数不同时短的那边补 0："1.9" 等价于 "1.9.0"
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}
