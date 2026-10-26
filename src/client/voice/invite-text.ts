/**
 * 邀请文案（零依赖版本：复制一段话，对方粘贴就能进）。
 *
 * 真正的"推送到对方"需要一条在线通道（Worker 或长连接），
 * 在那之前，复制文案是最稳的一步——微信群、QQ、私聊都能直接粘贴。
 */
export function buildInviteText(code: string, options: { count?: number; topic?: string } = {}): string {
  const lines = [`🎮 来 5blong 语音房`];
  const detail = [options.topic, options.count ? `${options.count} 人在` : ""]
    .filter((item): item is string => Boolean(item && item.trim()))
    .join(" · ");
  if (detail) lines.push(detail);
  lines.push(`房间 ${code}`);
  lines.push(`https://5blong.pages.dev/#c=${code}`);
  lines.push("点开就能进，免注册、免装客户端");
  return lines.join("\n");
}

/** 复制到剪贴板（WebView2 / 现代浏览器都支持；失败返回 false 让调用方提示）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
