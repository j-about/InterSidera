import { act, render, screen } from '@testing-library/react';

import { createSkyStore } from '../../state/store';
import VisibleObjects from './VisibleObjects';

describe('VisibleObjects', () => {
  it('says when nothing is labelled', () => {
    render(<VisibleObjects store={createSkyStore()} />);
    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent(
      'No object is labelled in the sky.',
    );
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('lists the visible labels as text with the count and marks the selection', () => {
    const store = createSkyStore({ sel: 'hip:32349' });
    render(<VisibleObjects store={store} />);
    act(() => {
      store.getState().actions.setVisibleLabels([
        { id: 'jupiter', kind: 'body', text: 'Jupiter' },
        { id: 'hip:32349', kind: 'selected', text: 'Sirius' },
        { id: 'n', kind: 'cardinal', text: 'N' },
      ]);
    });
    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent(
      '3 objects labelled in the sky',
    );
    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual(['Jupiter', 'Sirius (selected)', 'N']);
    act(() => {
      store.getState().actions.setVisibleLabels([{ id: 'n', kind: 'cardinal', text: 'N' }]);
    });
    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent(
      '1 object labelled in the sky',
    );
  });
});
