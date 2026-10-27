/**
 * 「按类名找元素」的一致性守卫。
 *
 * 为什么需要这条测试（2026-10-27 事故）：
 * 好友抽屉的操作浮层类名从 `.vx-friend-menu` 改成 `.vx-friend-sheet` 后，
 * 「点外面关闭」的判断还认着旧名字。于是点浮层里的「设置备注名 / 移除好友」时，
 * pointerdown 先被判成"点了外面"→ 浮层被关掉 → click 到达时按钮已经不在 DOM，
 * 用户看到的就是「点了没反应，界面直接消失」。
 *
 * 这类错误静态可查：`closest(".x")` / `querySelector(".x")` 里写的类名，
 * 必须真的出现在某个 tsx 的 className 里。改了名字忘了改调用处 → 这里直接红。
 *
 * 只查「结构性类名」（closest / querySelector / matches 的选择器），
 * 不查 CSS ↔ TSX 的双向 diff——那边动态拼接太多（`vx-pig-${phase}` 这类），
 * 误报会淹没真问题。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 从 `closest("...")` / `querySelector("...")` / `matches("...")` 里抽出类选择器。 */
function selectorsIn(source: string): string[] {
  const found: string[] = [];
  const callRe = /(?:closest|querySelector|querySelectorAll|matches)\(\s*"([^"]+)"/g;
  for (const match of source.matchAll(callRe)) {
    for (const cls of match[1]!.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      found.push(cls[1]!);
    }
  }
  return found;
}

/** 某个 tsx 里出现过的 className 词（含模板串里的静态片段）。 */
function classNamesIn(source: string): Set<string> {
  const names = new Set<string>();
  const attrRe = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{[^}]*?`([^`]*)`)/g;
  for (const match of source.matchAll(attrRe)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    // 模板串里的 `${...}` 先挖掉，只留静态部分（`vx-pig-${phase}` → `vx-pig-`）
    for (const cls of raw.replace(/\$\{[^}]*\}/g, " ").matchAll(/[a-zA-Z][\w-]*/g)) {
      names.add(cls[0]);
    }
    // 动态拼接的片段（`vx-pig-${phase}` 的 "vx-pig-"）也收进来做前缀匹配
    for (const dyn of raw.matchAll(/([a-zA-Z][\w-]*)\$\{/g)) {
      names.add(dyn[1]!);
    }
  }
  return names;
}

describe("DOM 选择器与 className 一致", () => {
  const files = walk(SRC);
  /** 全项目出现过的 className（含动态前缀），用来判断选择器是否可能命中。 */
  const allClassNames = new Set<string>();
  const prefixes = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".tsx")) continue;
    const names = classNamesIn(readFileSync(file, "utf8"));
    for (const name of names) {
      allClassNames.add(name);
      prefixes.add(name);
    }
  }

  const hitsClass = (cls: string): boolean => {
    if (allClassNames.has(cls)) return true;
    // `vx-screen` 这类前缀由 `vx-screen-${phase}` 生成
    for (const prefix of prefixes) {
      if (prefix.endsWith("-") && cls.startsWith(prefix)) return true;
    }
    return false;
  };

  it("closest/querySelector 用到的类名都真的存在于界面里", () => {
    const problems: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const cls of selectorsIn(source)) {
        if (hitsClass(cls)) continue;
        problems.push(`${path.relative(SRC, file)}: .${cls}`);
      }
    }
    expect(problems, `下面这些选择器在界面里找不到对应 className（改名后漏改？）：\n${problems.join("\n")}`).toEqual([]);
  });

  it("好友操作浮层必须叫 vx-friend-sheet（旧名 vx-friend-menu 会复活那个 bug）", () => {
    const panel = readFileSync(
      path.resolve(SRC, "client/voice/components/AccountPanels.tsx"),
      "utf8",
    );
    // 浮层容器用 vx-friend-sheet；vx-friend-menu-danger 是里面的按钮类名，允许保留
    expect(panel).toContain('className="vx-friend-sheet"');
    expect(panel).not.toMatch(/closest\("\.vx-friend-menu"\)/);
  });
});
