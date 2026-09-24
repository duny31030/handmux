import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import PaneSurfaceHost from '../src/components/PaneSurfaceHost.js';

function bundle(ownerKey: string, mode: 'conversation' | 'terminal') {
  const duplicateConversationKey = 'pi\0session-1';
  return (
    <PaneSurfaceHost
      ownerKey={ownerKey}
      primary={mode === 'conversation'
        ? <div key={duplicateConversationKey} className="agent-conversation-view" />
        : <div className="terminal-wrap" />}
      controls={mode === 'conversation'
        ? <div key={duplicateConversationKey} className="agent-conversation-composer" />
        : <div className="bottom-dock" />}
    />
  );
}

describe('PaneSurfaceHost', () => {
  it('atomically replaces a conversation and its controls without leaving duplicate-key DOM behind', () => {
    const view = render(bundle('%12\0conversation\0pi\0session-1', 'conversation'));
    expect(view.container.querySelectorAll('.agent-conversation-view')).toHaveLength(1);
    expect(view.container.querySelectorAll('.agent-conversation-composer')).toHaveLength(1);

    view.rerender(bundle('%12\0terminal', 'terminal'));
    expect(view.container.querySelectorAll('.agent-conversation-view')).toHaveLength(0);
    expect(view.container.querySelectorAll('.agent-conversation-composer')).toHaveLength(0);
    expect(view.container.querySelectorAll('.terminal-wrap')).toHaveLength(1);
    expect(view.container.querySelectorAll('.bottom-dock')).toHaveLength(1);

    view.rerender(bundle('%13\0conversation\0pi\0session-2', 'conversation'));
    expect(view.container.querySelectorAll('.terminal-wrap')).toHaveLength(0);
    expect(view.container.querySelectorAll('.bottom-dock')).toHaveLength(0);
    expect(view.container.querySelectorAll('.agent-conversation-view')).toHaveLength(1);
    expect(view.container.querySelectorAll('.agent-conversation-composer')).toHaveLength(1);
  });

  it('retains focused conversation controls when only the transcript surface changes', () => {
    const controlsKey = 'conversation-controls\0session-1\0window-1';
    const view = render(
      <PaneSurfaceHost
        ownerKey="%12\0chat-unavailable"
        controlsKey={controlsKey}
        primary={<div className="agent-conversation-view">loading</div>}
        controls={<textarea aria-label="composer" />}
      />,
    );
    const input = view.getByRole('textbox') as HTMLTextAreaElement;
    input.focus();

    view.rerender(
      <PaneSurfaceHost
        ownerKey="%12\0conversation\0pi\0session-1"
        controlsKey={controlsKey}
        primary={<div className="agent-conversation-view">loaded</div>}
        controls={<textarea aria-label="composer" />}
      />,
    );

    expect(view.getByRole('textbox')).toBe(input);
    expect(document.activeElement).toBe(input);
  });
});
