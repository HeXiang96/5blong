/**
 * 首页公告栏「最新更新」的唯一数据源。
 *
 * 发版约定（简洁版）：每次发版**只在数组最前面加一条**：
 *   { version: "x.y.z", date: "YYYY-MM-DD", lines: [最多 4 条短句] }
 * 首页公告栏自动展示最新一条并标注版本号；历史条目保留在下面备查。
 * 短句要求：每条一句话（建议 ≤ 16 字），说人话、讲变化，不堆术语。
 *
 * `npm run bump` 的收尾输出里也会提醒这一步（见 scripts/bump-version.mjs）。
 */

export interface ChangelogEntry {
  /** 对应桌面端/网页的版本号（与 package.json 一致）。 */
  version: string;
  /** 发布日期（YYYY-MM-DD）。 */
  date: string;
  /** 简洁版更新条目：最多 4 条，每条一句话。 */
  lines: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    // 纯 bug 修复版本：lines 留空 → 公告栏跳过它，继续展示上一条有内容版本
    version: "1.0.5",
    date: "2026-10-13",
    lines: [],
  },
  {
    version: "1.0.4",
    date: "2026-10-13",
    lines: [
      "小猪换 3D 新形象，全套动作上线",
      "新互动「吊起来」：把朋友的猪吊到半空",
      "新成员降落伞空降入场",
      "场景与界面跟随早晚自动变色",
    ],
  },
];

/** 公告栏展示用：最新一条**有内容**的记录（纯修复版本 lines 为空会跳过）。 */
export function latestChangelog(): ChangelogEntry | undefined {
  return CHANGELOG.find((entry) => entry.lines.length > 0);
}
