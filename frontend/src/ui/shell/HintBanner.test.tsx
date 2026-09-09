import { fireEvent, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import HintBanner from './HintBanner';

describe('HintBanner', () => {
  it('shows the hint until dismissed with its button', () => {
    const store = createSkyStore();
    render(<HintBanner store={store} />);
    const hint = screen.getByRole('status', { name: 'Getting started' });
    expect(hint).toHaveTextContent('Drag to look around');
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(store.getState().ui.hintDismissed).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('disappears on the first pointer interaction with the sky stage', () => {
    const store = createSkyStore();
    render(
      <>
        <div id="sky-stage" />
        <HintBanner store={store} />
      </>,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    const stage = document.getElementById('sky-stage');
    if (stage === null) {
      throw new Error('stage missing');
    }
    fireEvent.pointerDown(stage);
    expect(store.getState().ui.hintDismissed).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders nothing once the store says dismissed', () => {
    const store = createSkyStore();
    store.getState().actions.dismissHint();
    render(<HintBanner store={store} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
