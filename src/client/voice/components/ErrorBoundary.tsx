/**
 * 错误边界：把"某一小块渲染炸了"变成"那块换个提示"，而不是整窗白屏。
 *
 * 为什么需要（2026-10-26 业主实测）：房间里有共享时，后进房的人点开灯箱
 * 直接一片空白，连退出按钮都没有——React 里任何未捕获的渲染/effect 异常都会
 * 卸载整棵树，用户看到的就是"整个应用没了"。
 *
 * 用法：
 * - 局部用（灯箱）：`onError` 里顺手把这块关掉，回到房间继续说话；
 * - 顶层用（App）：整页兜底，给一个"重新加载"，并把错误留在控制台可查。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** 出现错误时显示的替代内容；给了就覆盖默认卡片 */
  fallback?: ReactNode;
  /** 出错回调：局部边界通常用它把这块 UI 关掉 */
  onError?: (error: Error) => void;
  /** 出错时是否顺带打印到控制台（默认打印，排查离不开它） */
  quiet?: boolean;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (!this.props.quiet) {
      // 留证据：白屏事故最怕的就是"什么都没有"，至少控制台里要有栈
      console.error("[ui] 渲染出错，已降级：", error, info.componentStack);
    }
    this.props.onError?.(error);
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div className="vx-crash" role="alert">
        <b>这块界面出错了</b>
        <p>{error.message || "未知错误"}</p>
        <div className="vx-crash-actions">
          <button type="button" className="vx-btn vx-btn-ghost" onClick={this.reset}>
            重试
          </button>
          <button type="button" className="vx-btn" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
