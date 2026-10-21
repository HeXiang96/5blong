/**
 * 诊断包导出。
 *
 * 参考 Piik 的做法：本地生成、用户自己保存、不做云端上传；
 * 内容只含运行状态与统计，不含 peerId / personId / IP / 候选地址。
 */
export function downloadDiagnostics(bundle: Record<string, unknown>): string {
  const json = JSON.stringify(bundle, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const a = document.createElement("a");
  a.href = url;
  a.download = `5blong-diagnostics-${stamp}.json`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 稍后再释放，避免个别浏览器在下载启动前就把 blob 回收
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  // 返回文件名：提示条要告诉用户"存成什么了"，否则不知道去哪儿找
  return a.download;
}
