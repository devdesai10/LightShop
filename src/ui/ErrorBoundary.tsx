// Keeps a crash inside one module from unmounting the whole app (which leaves an empty, dark window).

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './controls';

interface Props {
  /** Shown in the message, e.g. "Develop". */
  area: string;
  onLeave?: () => void;
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

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.area} crashed`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="empty" role="alert">
        <h3>{this.props.area} ran into a problem</h3>
        <div className="muted" style={{ maxWidth: 520, textAlign: 'center' }}>
          {error.message || String(error)}
        </div>
        <div className="row">
          <Button primary onClick={() => this.setState({ error: null })}>
            Try Again
          </Button>
          {this.props.onLeave && <Button onClick={this.props.onLeave}>Back to Library</Button>}
        </div>
      </div>
    );
  }
}
