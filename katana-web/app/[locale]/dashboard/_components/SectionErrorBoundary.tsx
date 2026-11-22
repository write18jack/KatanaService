"use client";

import { Component, type ReactNode } from "react";

type SectionErrorBoundaryProps = {
  fallback: ReactNode;
  children: ReactNode;
};

/**
 * 1セクション分の描画・データ取得エラーだけを受け止める小さなerror boundary。
 * Dashboard全体を落とさず、かつ「0件」と見分けがつくfallbackを表示するために使う。
 * エラーの内容（DB内部情報・stack trace）は画面に出さない。
 */
export class SectionErrorBoundary extends Component<SectionErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
