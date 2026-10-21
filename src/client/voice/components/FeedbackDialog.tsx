import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_MAX_CONTACT,
  FEEDBACK_MAX_MESSAGE,
  buildFeedbackPayload,
  collectFeedbackContext,
  feedbackErrorText,
  submitFeedback,
  type FeedbackCategory,
} from "../feedback";

/**
 * 意见反馈弹窗（客户端与网页版共用）。
 *
 * 适配要求（业主强调）：
 * - **跟随主题**：全部用 --vx-* 变量，浅色/深色自动成立；
 * - **任意窗口尺寸**：面板限高 + 内部滚动，窄屏（手机/小窗）铺满宽度、按钮换行；
 * - **不遮挡关键操作**：标题栏、可滚动主体、固定底部操作区三段式；
 * - **可键盘操作**：ESC 关闭、打开即聚焦描述框、aria-modal。
 */
export function FeedbackDialog({
  open,
  errorText,
  onCollectDiagnostics,
  onClose,
}: {
  open: boolean;
  /** 从错误提示条进入时带上的原文（自动填进环境信息） */
  errorText?: string;
  /** 采集当前连接诊断（延迟/丢包/重连记录）；没有房间时返回 null */
  onCollectDiagnostics?: () => Promise<Record<string, unknown> | null>;
  onClose: () => void;
}) {
  const [category, setCategory] = useState<FeedbackCategory>("other");
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  /** 是否附带连接诊断（默认带：排查"断线/没声音"这类问题，没有它基本没法定位） */
  const [attachDiag, setAttachDiag] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 环境信息在弹窗打开那一刻采集一次（会话内不随输入变化）
  const [context, setContext] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setContext(collectFeedbackContext({ errorText }));
    setResult(null);
    setCategory(errorText ? "other" : "other");
  }, [open, errorText]);

  useEffect(() => {
    if (!open) return;
    // 打开即聚焦描述框：少一次点击
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 60);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    // 锁背后滚动：面板内部自己滚，别把房间页面带着动
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, submitting, onClose]);

  if (!open) return null;

  const trimmed = message.trim();
  const canSubmit = trimmed.length >= 2 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setResult(null);
    const nextContext = { ...context };
    if (attachDiag && onCollectDiagnostics) {
      const diag = await onCollectDiagnostics();
      if (diag) {
        /*
         * 服务端上限 64KB（原来 2KB 且超长会整包丢弃）。
         * 这里先截到 48K 字符：诊断包里最长的是事件列表，砍尾巴不影响定责。
         */
        nextContext.diag = JSON.stringify(diag).slice(0, 48_000);
      }
    }
    const payload = buildFeedbackPayload({ category, message, contact }, nextContext);
    const outcome = await submitFeedback(payload);
    setSubmitting(false);
    if (outcome.ok) {
      setResult({ kind: "ok", text: "收到，谢谢！已进入我们的处理清单" });
      setMessage("");
      setContact("");
    } else {
      setResult({ kind: "error", text: feedbackErrorText(outcome) });
    }
  };

  return createPortal(
    <div
      className="vx-feedback-backdrop"
      onMouseDown={(event) => {
        // 点遮罩关闭；但提交中不允许误关
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div className="vx-feedback" role="dialog" aria-modal="true" aria-label="意见反馈" ref={panelRef} tabIndex={-1}>
        <header className="vx-feedback-head">
          <strong>意见反馈</strong>
          <button type="button" className="vx-icon-btn" onClick={onClose} aria-label="关闭" disabled={submitting}>
            ×
          </button>
        </header>

        <div className="vx-feedback-body">
          <label className="vx-feedback-field">
            <span className="vx-feedback-label">问题类型</span>
            <select
              className="vx-feedback-select"
              value={category}
              onChange={(event) => setCategory(event.target.value as FeedbackCategory)}
            >
              {FEEDBACK_CATEGORIES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <label className="vx-feedback-field">
            <span className="vx-feedback-label">
              问题描述
              <em className="vx-feedback-count">
                {trimmed.length}/{FEEDBACK_MAX_MESSAGE}
              </em>
            </span>
            <textarea
              ref={textareaRef}
              className="vx-feedback-textarea"
              value={message}
              maxLength={FEEDBACK_MAX_MESSAGE}
              rows={5}
              placeholder="说清「什么现象 + 怎么复现」就够了，比如：一共享屏幕，观众就说听不到声音，我摘掉耳机再试也一样"
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>

          <label className="vx-feedback-field">
            <span className="vx-feedback-label">
              联系方式<em className="vx-feedback-optional">选填</em>
            </span>
            <input
              className="vx-feedback-input"
              value={contact}
              maxLength={FEEDBACK_MAX_CONTACT}
              placeholder="QQ / 微信 / 邮箱，想跟进时方便找你"
              onChange={(event) => setContact(event.target.value)}
            />
          </label>

          <label className="vx-feedback-check">
            <input
              type="checkbox"
              checked={attachDiag}
              onChange={(event) => setAttachDiag(event.target.checked)}
            />
            <span>附上我的连接信息（延迟、丢包、最近的重连记录；不含聊天和录音）</span>
          </label>

          <div className="vx-feedback-context">
            <button
              type="button"
              className="vx-feedback-context-toggle"
              onClick={() => setContextOpen((value) => !value)}
              aria-expanded={contextOpen}
            >
              {contextOpen ? "▾" : "▸"} 会自动附上这些技术信息（点开看看）
            </button>
            {contextOpen ? (
              <div className="vx-feedback-context-body">
                {Object.entries(context).map(([key, value]) => (
                  <span className="vx-feedback-kv" key={key}>
                    {key}: {value}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <p className="vx-feedback-privacy">
            不会上传房间链接 / 房间密码 / 聊天内容；联系方式只在填写时收集。
          </p>

          {result ? (
            <p className={`vx-feedback-result vx-feedback-result-${result.kind}`} role="status">
              {result.text}
            </p>
          ) : null}
        </div>

        <footer className="vx-feedback-foot">
          <button type="button" className="vx-btn vx-btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="button" className="vx-btn" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting ? "提交中…" : "提交反馈"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
