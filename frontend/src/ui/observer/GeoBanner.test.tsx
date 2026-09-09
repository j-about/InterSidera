import { act, render, screen } from '@testing-library/react';
import i18next from 'i18next';

import { createSkyStore } from '../../state/store';
import GeoBanner from './GeoBanner';

// The shell-level explanation: a named status region while the browser prompt is up, nothing
// in every other status (the panel carries the failure hints).

describe('GeoBanner', () => {
  it('explains the prompt while prompting and disappears with any other status', () => {
    const store = createSkyStore();
    const { container } = render(<GeoBanner store={store} />);
    expect(container).toBeEmptyDOMElement();
    act(() => {
      store.getState().actions.setGeo('prompting');
    });
    expect(screen.getByRole('status', { name: 'Your location' })).toHaveTextContent(
      i18next.t('geo.explain'),
    );
    for (const status of ['granted', 'denied', 'unavailable', 'timeout'] as const) {
      act(() => {
        store.getState().actions.setGeo(status);
      });
      expect(screen.queryByRole('status')).toBeNull();
    }
  });
});
