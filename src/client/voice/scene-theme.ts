/**
 * 场景主题（房主可切换，全房同步）。
 *
 * 与"时段"（daypart，跟随本地时钟）是两个独立维度：
 * - daypart 决定光照/天色基线；
 * - 场景主题在此之上叠加一套完整氛围（调色 + 地面装饰 + 猪的小装扮）。
 *
 * 空串 = 跟随默认（只有时段）；"snow" 雪原 / "halloween" 万圣夜。
 * 主题只在会话内有效（关房即散），符合"临时房间"的定位。
 */

export type SceneThemeId = "snow" | "halloween";

export interface SceneThemeMeta {
  id: SceneThemeId;
  label: string;
  emoji: string;
  /** 房间铭牌上的选择条顺序。 */
  order: number;
}

export const SCENE_THEMES: SceneThemeMeta[] = [
  { id: "snow", label: "雪原", emoji: "❄️", order: 1 },
  { id: "halloween", label: "万圣夜", emoji: "🎃", order: 2 },
];

/** 严格校验：协议里收到的主题 id 必须是白名单内的（防脏数据注入 DOM 属性）。 */
export function isSceneThemeId(value: unknown): value is SceneThemeId {
  return value === "snow" || value === "halloween";
}

/** 解析协议字段："" / 非法值统一视为"默认主题"。 */
export function parseSceneTheme(value: unknown): SceneThemeId | "" {
  return isSceneThemeId(value) ? value : "";
}

/** 开发/验收用：?scene=snow 可本地强制主题（纯视觉覆盖，无副作用）。 */
export function sceneOverride(search: string): SceneThemeId | "" {
  return parseSceneTheme(new URLSearchParams(search).get("scene"));
}
