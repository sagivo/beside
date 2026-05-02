import * as React from 'react';
import { ErrorView } from '@/components/ErrorView';

interface Props {
  /** Reset key — when this changes (e.g. screen change), the boundary resets. */
  resetKey?: unknown;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Surfacing to console keeps the existing window.onerror UX in index.html
    // unchanged for users who don't have devtools open.
    console.error('Screen crashed:', error, info);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="pt-6">
          <ErrorView
            error={this.state.error.message || String(this.state.error)}
            onRetry={this.handleRetry}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
